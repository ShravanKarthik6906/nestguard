
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import * as Cesium from 'cesium'
import { jsPDF } from 'jspdf'
import DroneSimulator from './components/DroneSimulator'
import MissionMap from './components/MissionMap'
import RiskDashboard from './components/RiskDashboard'
import { getWeather } from './services/weather'
import { getInfrastructure } from './services/infrastructure'
import { getWildlife } from './services/wildlife'
import { getAirspace } from './services/airspace'
import { assessRisk } from './services/riskEngine'
import { getAIAnalysis } from './services/ai'
import { getKnowFlyZoneCheck, bandOf } from './services/knowflyzone'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './index.css'

// Start where the KnowFlyZone app sent us (/fly/?lat=..&lon=..), otherwise RPI campus.
const START = (() => {
  const q = new URLSearchParams(window.location.search)
  const lat = Number(q.get('lat'))
  const lon = Number(q.get('lon'))
  const ok = q.get('lat') !== null && q.get('lon') !== null &&
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  return ok ? [lon, lat] : [-73.6767, 42.7298]
})()
const RAD = Math.PI / 180
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))

function position(lon, lat, height) {
  return Cesium.Cartesian3.fromDegrees(lon, lat, height)
}

function offset(origin, east, north, up) {
  return Cesium.Matrix4.multiplyByPoint(
    Cesium.Transforms.eastNorthUpToFixedFrame(origin),
    new Cesium.Cartesian3(east, north, up),
    new Cesium.Cartesian3()
  )
}

function coordinates(point) {
  const c = Cesium.Cartographic.fromCartesian(point)
  return [
    Cesium.Math.toDegrees(c.longitude),
    Cesium.Math.toDegrees(c.latitude),
    c.height
  ]
}

function distance(a, b) {
  const latitude = (a[1] + b[1]) * RAD / 2
  return Math.hypot(
    (b[0] - a[0]) * 111320 * Math.cos(latitude),
    (b[1] - a[1]) * 111320
  )
}

function routeBetween(start, end, wind = 0) {
  if (!end) return null

  const meters = distance(start, end)
  const seconds = meters / Math.max(4, 10 - wind * 0.15)

  return {
    coordinates: [start, end],
    distanceMeters: Math.round(meters),
    estimatedSeconds: Math.round(seconds),
    batteryUsePercent: Math.min(
      100,
      Number((seconds * 100 / (24 * 60)).toFixed(1))
    )
  }
}

function clock(seconds) {
  const n = Math.max(0, Math.floor(seconds))
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

function downloadReport(report) {
  const pdf = new jsPDF()
  let y = 18

  const write = (content, heading = false) => {
    pdf.setFont('helvetica', heading ? 'bold' : 'normal')
    pdf.setFontSize(heading ? 14 : 10)

    const lines = pdf.splitTextToSize(String(content), 175)

    for (const line of lines) {
      if (y > 277) {
        pdf.addPage()
        y = 18
      }
      pdf.text(line, 17, y)
      y += heading ? 8 : 5
    }
    y += 3
  }

  write('KNOWFLYZONE FLIGHT SIMULATOR: MISSION REPORT', true)
  write(`Generated: ${new Date().toLocaleString()}`)
  write(`Launch: ${report.location[1].toFixed(5)}, ${report.location[0].toFixed(5)}`)
  write(`Duration: ${clock(report.duration)}`)
  write(`Distance traveled: ${Math.round(report.distance)} meters`)
  write(`Battery remaining: ${Math.round(report.battery)}%`)
  write(`Pre-flight risk: ${report.risk.score ?? 'No data'}/100 (${report.risk.level.toLowerCase()})`)

  write('RISK FACTORS', true)
  for (const factor of report.risk.factors || []) {
    write(`${factor.name}: ${factor.score ?? 'No data'}, ${factor.detail}`)
  }

  write('WARNINGS', true)
  for (const warning of report.risk.warnings || []) write(warning)

  write('FLIGHT EVENTS', true)
  if (!report.events.length) write('No events recorded')
  for (const event of report.events) {
    write(`T+${event.time}s: ${event.text}`)
  }

  if (report.aiAnalysis) {
    write('GEMINI ANALYSIS', true)
    write(report.aiAnalysis)
  }

  write('IMPORTANT LIMITATIONS', true)
  write(
    'Experimental simulator only. Airspace authorization has not been ' +
    'verified. Infrastructure mapping may be incomplete. Wildlife data ' +
    'is historical. Flight physics, battery use and obstacle clearances ' +
    'are approximations, not validated aviation guidance.'
  )

  pdf.save(`KnowFlyZone_Flight_${Date.now()}.pdf`)
}

export default function App() {
  const globeElement = useRef(null)
  const viewerRef = useRef(null)
  const tilesRef = useRef(null)
  const droneRef = useRef(null)
  const mapRef = useRef(null)
  const flightRef = useRef(null)
  const keysRef = useRef(new Set())
  const modeRef = useRef('plan')
  const cameraRef = useRef('CHASE')
  const zoomRef = useRef(12)
  const locationRef = useRef(START)
  const requestRef = useRef(0)
  const abortRef = useRef([])
  const flightWeatherRef = useRef(null)

  const [sceneStatus, setSceneStatus] = useState('LOADING 3D')
  const [sceneError, setSceneError] = useState('')
  const [mode, setMode] = useState('plan')
  const [location, setLocation] = useState(START)
  const [destination, setDestination] = useState(null)
  const [weather, setWeather] = useState(null)
  const [infrastructure, setInfrastructure] = useState(null)
  const [wildlife, setWildlife] = useState(null)
  const [airspace, setAirspace] = useState(null)
  const [kfz, setKfz] = useState(null)
  const [battery, setBattery] = useState(100)
  const [cameraMode, setCameraMode] = useState('CHASE')
  const [zoom, setZoom] = useState(12)
  const [flightPath, setFlightPath] = useState([])
  const [aiAnalysis, setAiAnalysis] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState({
    weather: true,
    infrastructure: true,
    wildlife: true
  })
  const [errors, setErrors] = useState({})
  const [telemetry, setTelemetry] = useState({
    altitude: 0,
    speed: 0,
    battery: 100,
    time: 0,
    distance: 0,
    heading: 0,
    clearance: null,
    events: 0
  })

  const risk = useMemo(() => {
    const local = assessRisk({
      weather,
      infrastructure,
      wildlife,
      airspace,
      battery
    })
    // Show the same score as the KnowFlyZone app; fall back to the simulator's estimate
    const score = kfz ? kfz.score : local.score
    return {
      ...local,
      score,
      level: bandOf(score),
      driver: kfz?.driver || '',
      source: kfz ? 'KnowFlyZone check' : 'Simulator estimate (KnowFlyZone check unavailable)'
    }
  }, [weather, infrastructure, wildlife, airspace, battery, kfz])

  const route = useMemo(
    () => routeBetween(location, destination, weather?.wind || 0),
    [location, destination, weather]
  )

  function changeMode(value) {
    modeRef.current = value
    setMode(value)
  }

  const refreshData = useCallback((coords) => {
    const version = ++requestRef.current

    abortRef.current.forEach(controller => controller.abort())
    abortRef.current = Array.from(
      { length: 3 },
      () => new AbortController()
    )

    setWeather(null)
    setInfrastructure(null)
    setWildlife(null)
    setErrors({})
    setLoading({
      weather: true,
      infrastructure: true,
      wildlife: true
    })

    const [lon, lat] = coords

    const requests = [
      ['weather', getWeather(lat, lon, abortRef.current[0].signal), setWeather],
      [
        'infrastructure',
        getInfrastructure(lat, lon, abortRef.current[1].signal),
        setInfrastructure
      ],
      ['wildlife', getWildlife(lat, lon, abortRef.current[2].signal), setWildlife]
    ]

    for (const [name, promise, setter] of requests) {
      Promise.resolve(promise)
        .then(data => {
          if (version === requestRef.current) setter(data)
        })
        .catch(error => {
          if (version === requestRef.current) {
            setErrors(previous => ({
              ...previous,
              [name]: error.message || 'Request failed'
            }))
          }
        })
        .finally(() => {
          if (version === requestRef.current) {
            setLoading(previous => ({
              ...previous,
              [name]: false
            }))
          }
        })
    }

    setKfz(null)
    getKnowFlyZoneCheck(lat, lon, abortRef.current[0].signal)
      .then(data => {
        if (version === requestRef.current) setKfz(data)
      })
      .catch(() => {
        if (version === requestRef.current) setKfz(null)
      })

    getAirspace(lat, lon)
      .then(data => {
        if (version === requestRef.current) setAirspace(data)
      })
      .catch(() => {
        if (version === requestRef.current) setAirspace(null)
      })
  }, [])

  useEffect(() => {
    refreshData(location)
    return () => {
      requestRef.current++
      abortRef.current.forEach(controller => controller.abort())
    }
  }, [location, refreshData])

  useEffect(() => {
    let disposed = false
    let viewer = null

    async function setup() {
      const token = import.meta.env.VITE_CESIUM_ION_ACCESS_TOKEN

      if (!token) {
        setSceneStatus('TOKEN MISSING')
        setSceneError('The 3D view needs a Cesium ion token in sim/.env.local on the server')
        return
      }

      Cesium.Ion.defaultAccessToken = token

      viewer = new Cesium.Viewer(globeElement.current, {
        animation: false,
        timeline: false,
        geocoder: false,
        homeButton: false,
        baseLayerPicker: false,
        baseLayer: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        requestRenderMode: false
      })

      if (disposed) {
        viewer.destroy()
        return
      }

      viewerRef.current = viewer
      viewer.imageryLayers.removeAll()
      viewer.scene.globe.show = false
      viewer.scene.skyAtmosphere.show = false
      viewer.scene.screenSpaceCameraController.enableInputs = false

      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString(
        '#0e1013'
      )

      viewer.camera.setView({
        destination: position(START[0], START[1], 1100),
        orientation: {
          heading: 0,
          pitch: -65 * RAD,
          roll: 0
        }
      })

      viewer.scene.renderError.addEventListener((scene, error) => {
        if (disposed) return
        console.error('KnowFlyZone simulator 3D render error:', error)
        setSceneError(`3D render error: ${error.message || error}`)
        setSceneStatus('3D RENDER ERROR')
      })

      try {
        const tiles = await Cesium.Cesium3DTileset.fromIonAssetId(2275207)

        if (disposed) {
          tiles.destroy()
          return
        }

        tilesRef.current = tiles

        tiles.tileFailed.addEventListener(error => {
          console.warn('Google 3D tile failed:', error)
        })

        viewer.scene.primitives.add(tiles)
        setSceneStatus('GOOGLE PHOTOREALISTIC 3D')
      } catch (error) {
        if (!disposed) {
          setSceneStatus('3D TILES UNAVAILABLE')
          setSceneError(`Google 3D Tiles: ${error.message}`)
        }
      }
    }

    setup().catch(error => {
      if (!disposed) {
        setSceneStatus('3D INITIALIZATION ERROR')
        setSceneError(error.message || String(error))
      }
    })

    return () => {
      disposed = true
      tilesRef.current = null
      viewerRef.current = null
      if (viewer && !viewer.isDestroyed()) viewer.destroy()
    }
  }, [])

  const changeLocation = useCallback(coords => {
    if (modeRef.current !== 'plan') return

    locationRef.current = coords
    setLocation(coords)
    setDestination(null)
    setAiAnalysis('')

    const viewer = viewerRef.current
    if (viewer && !viewer.isDestroyed()) {
      viewer.camera.flyTo({
        destination: position(coords[0], coords[1], 1100),
        orientation: {
          heading: 0,
          pitch: -65 * RAD,
          roll: 0
        },
        duration: 1
      })
    }
  }, [])

  useEffect(() => {
    const valid = new Set([
      'w', 'a', 's', 'd', 'q', 'e',
      'arrowleft', 'arrowright'
    ])

    function down(event) {
      const key = event.key.toLowerCase()
      if (
        modeRef.current !== 'fly' ||
        !valid.has(key) ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(
          document.activeElement?.tagName
        )
      ) return

      event.preventDefault()
      keysRef.current.add(key)
    }

    function up(event) {
      keysRef.current.delete(event.key.toLowerCase())
    }

    function clear() {
      keysRef.current.clear()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)

    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useEffect(() => {
    let frame
    let previous = performance.now()
    let lastUI = 0
    let lastMap = 0
    let lastGround = 0
    let cameraPosition = null

    function animate(now) {
      frame = requestAnimationFrame(animate)

      const dt = clamp((now - previous) / 1000, 0, 0.05)
      previous = now

      const viewer = viewerRef.current
      const flight = flightRef.current

      if (!flight || !viewer || viewer.isDestroyed()) {
        droneRef.current?.update({ active: false })
        return
      }

      const flying = modeRef.current === 'fly'
      const visible = flying || modeRef.current === 'pause'

      if (flying) {
        const keys = keysRef.current

        const forward = Number(keys.has('w')) - Number(keys.has('s'))
        const sideways = Number(keys.has('d')) - Number(keys.has('a'))
        const vertical = Number(keys.has('e')) - Number(keys.has('q'))
        const yaw = Number(keys.has('arrowright')) -
          Number(keys.has('arrowleft'))

        flight.heading += yaw * 1.4 * dt

        const scale = Math.max(1, Math.hypot(forward, sideways))

        const east = (
          Math.sin(flight.heading) * forward +
          Math.cos(flight.heading) * sideways
        ) * 12 / scale

        const north = (
          Math.cos(flight.heading) * forward -
          Math.sin(flight.heading) * sideways
        ) * 12 / scale

        const response = 1 - Math.exp(-dt * 3)

        flight.ve += (east - flight.ve) * response
        flight.vn += (north - flight.vn) * response
        flight.vu += (vertical * 5 - flight.vu) * response

        const wind = flightWeatherRef.current?.wind || 0
        const windDirection =
          (flightWeatherRef.current?.windDirection || 0) * RAD

        const windEast = -Math.sin(windDirection) * wind * 0.15
        const windNorth = -Math.cos(windDirection) * wind * 0.15

        const de = (flight.ve + windEast) * dt
        const dn = (flight.vn + windNorth) * dt
        const du = flight.vu * dt

        const nextE = flight.e + de
        const nextN = flight.n + dn
        const nextU = clamp(flight.u + du, 3, 200)

        const nextPosition = offset(
          flight.origin,
          nextE,
          nextN,
          nextU
        )

        const nextGeo = coordinates(nextPosition)

        const clearance = Number.isFinite(flight.groundHeight)
          ? nextGeo[2] - flight.groundHeight
          : null

        if (clearance === null || clearance >= 3) {
          flight.e = nextE
          flight.n = nextN
          flight.u = nextU
          flight.distance += Math.hypot(de, dn, du)
        } else {
          flight.vu = 0

          if (flight.time - flight.lastWarning > 5) {
            flight.events.push({
              time: Math.round(flight.time),
              text: 'Low ground-clearance warning'
            })
            flight.lastWarning = flight.time
          }
        }

        flight.pitch += (-forward * 0.15 - flight.pitch) * response
        flight.roll += (-sideways * 0.15 - flight.roll) * response

        flight.time += dt

        const effort = Math.hypot(flight.ve, flight.vn) / 12
        const drain = 100 / (24 * 60) *
          (1 + effort * 0.4 + wind / 25)

        flight.battery = Math.max(
          0,
          flight.battery - drain * dt
        )

        if (flight.battery < 20 && !flight.lowWarning) {
          flight.lowWarning = true
          flight.events.push({
            time: Math.round(flight.time),
            text: 'Battery below 20%'
          })
        }

        if (flight.battery <= 0) {
          keysRef.current.clear()
          changeMode('pause')
        }
      }

      const dronePosition = offset(
        flight.origin,
        flight.e,
        flight.n,
        flight.u
      )

      const geo = coordinates(dronePosition)

      // Google 3D Tiles provide a visual surface, not a terrain
      // provider. Sampling can fail if tiles are not loaded.
      // In that case clearance stays UNKNOWN.
      if (now - lastGround > 1500) {
        try {
          const sample = viewer.scene.sampleHeight(
            Cesium.Cartographic.fromDegrees(geo[0], geo[1]),
            [],
            1
          )

          if (Number.isFinite(sample)) {
            flight.groundHeight = sample
          }
        } catch {
          // Preserve the last known height, if any.
        }
        lastGround = now
      }

      const clearance = Number.isFinite(flight.groundHeight)
        ? geo[2] - flight.groundHeight
        : null

      droneRef.current?.update({
        active: visible,
        cameraMode: cameraRef.current,
        zoom: zoomRef.current,
        pitch: flight.pitch,
        roll: flight.roll,
        throttle: flying ? 0.8 : 0.4
      })

      if (visible) {
        const heading = flight.heading
        const selected = cameraRef.current

        const back = selected === 'TOP'
          ? 0
          : selected === 'FPV'
            ? 0.5
            : zoomRef.current

        const up = selected === 'TOP'
          ? 65
          : selected === 'FPV'
            ? 0.6
            : zoomRef.current * 0.5

        const desired = offset(
          dronePosition,
          -Math.sin(heading) * back,
          -Math.cos(heading) * back,
          up
        )

        if (
          !cameraPosition ||
          Cesium.Cartesian3.distance(cameraPosition, desired) > 250
        ) {
          cameraPosition = Cesium.Cartesian3.clone(desired)
        } else {
          Cesium.Cartesian3.lerp(
            cameraPosition,
            desired,
            1 - Math.exp(-dt * 7),
            cameraPosition
          )
        }

        const target = selected === 'FPV'
          ? offset(
              dronePosition,
              Math.sin(heading) * 80,
              Math.cos(heading) * 80,
              0
            )
          : dronePosition

        const direction = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(
            target,
            cameraPosition,
            new Cesium.Cartesian3()
          ),
          new Cesium.Cartesian3()
        )

        const upVector = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(
            offset(dronePosition, 0, 0, 1),
            dronePosition,
            new Cesium.Cartesian3()
          ),
          new Cesium.Cartesian3()
        )

        viewer.camera.setView({
          destination: cameraPosition,
          orientation: {
            direction,
            up: upVector
          }
        })
      } else {
        cameraPosition = null
      }

      if (visible && now - lastMap > 450) {
        mapRef.current?.followDrone(geo[0], geo[1])

        if (flying) {
          flight.path.push([geo[0], geo[1]])
          if (flight.path.length > 1000) flight.path.shift()
          setFlightPath([...flight.path])
        }

        lastMap = now
      }

      if (now - lastUI > 200) {
        setTelemetry({
          altitude: Math.round(flight.u),
          speed: Math.round(Math.hypot(flight.ve, flight.vn) * 3.6),
          battery: Math.round(flight.battery),
          time: Math.round(flight.time),
          distance: Math.round(flight.distance),
          heading: Math.round(
            ((flight.heading / RAD) % 360 + 360) % 360
          ),
          clearance: clearance === null
            ? null
            : Math.round(clearance),
          events: flight.events.length
        })

        lastUI = now
      }
    }

    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [])

  async function launch() {
    const viewer = viewerRef.current

    if (!viewer || viewer.isDestroyed() || !tilesRef.current) {
      setSceneError('The 3D view is still loading. Try again in a few seconds.')
      return
    }

    const [lon, lat] = locationRef.current

    let groundHeight = null

    try {
      const sampled = viewer.scene.sampleHeight(
        Cesium.Cartographic.fromDegrees(lon, lat),
        [],
        1
      )

      if (Number.isFinite(sampled)) {
        groundHeight = sampled
      }
    } catch {
      // A missing tile surface must not crash the simulator.
    }

    // This is a simulated starting altitude, not verified AGL.
    const originHeight = Number.isFinite(groundHeight)
      ? groundHeight
      : 0

    flightRef.current = {
      origin: position(lon, lat, originHeight),
      e: 0,
      n: 0,
      u: 24,
      ve: 0,
      vn: 0,
      vu: 0,
      heading: 0,
      pitch: 0,
      roll: 0,
      time: 0,
      distance: 0,
      battery,
      groundHeight,
      path: [[lon, lat]],
      events: [],
      lastWarning: -10,
      lowWarning: false
    }

    flightWeatherRef.current = weather
    keysRef.current.clear()
    setFlightPath([])
    setReport(null)
    setSceneError('')
    cameraRef.current = 'CHASE'
    setCameraMode('CHASE')
    changeMode('fly')
  }

  function togglePause() {
    keysRef.current.clear()
    changeMode(modeRef.current === 'fly' ? 'pause' : 'fly')
  }

  function cycleCamera() {
    const modes = ['CHASE', 'FPV', 'TOP']
    const next = modes[
      (modes.indexOf(cameraRef.current) + 1) % modes.length
    ]

    cameraRef.current = next
    setCameraMode(next)
  }

  function endMission() {
    const f = flightRef.current
    if (!f) return

    keysRef.current.clear()

    setReport({
      location: [...locationRef.current],
      duration: f.time,
      distance: f.distance,
      battery: f.battery,
      events: [...f.events],
      risk,
      aiAnalysis
    })

    changeMode('report')
  }

  function resetMission() {
    flightRef.current = null
    keysRef.current.clear()
    setFlightPath([])
    setReport(null)
    changeMode('plan')

    const [lon, lat] = locationRef.current
    const viewer = viewerRef.current

    if (viewer && !viewer.isDestroyed()) {
      viewer.camera.flyTo({
        destination: position(lon, lat, 1100),
        orientation: {
          heading: 0,
          pitch: -65 * RAD,
          roll: 0
        },
        duration: 1
      })
    }

    mapRef.current?.flyTo(lon, lat)
  }

  async function analyzeWithGemini() {
    setAiLoading(true)
    setAiError('')
    setAiAnalysis('')

    try {
      const result = await getAIAnalysis({
        location,
        weather,
        infrastructure: infrastructure && {
          count: infrastructure.count,
          nearest: infrastructure.nearest,
          radius: infrastructure.radius
        },
        wildlife: wildlife && {
          speciesCount: wildlife.speciesCount,
          radiusKm: wildlife.radiusKm,
          topSpecies: wildlife.species?.slice(0, 8)
        },
        airspace,
        risk,
        route,
        battery
      })

      setAiAnalysis(result.analysis)
    } catch (error) {
      setAiError(error.message || 'Gemini request failed')
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="skyguard-v4">
      <div className="sky-globe" ref={globeElement} />

      <DroneSimulator ref={droneRef} active={false} />

      <header className="sky-topbar">
        <div className="sky-logo">
          <a href="/preflight">KnowFlyZone</a> <span>Flight simulator</span>
        </div>

        <div className="sky-top-status">
          {mode === 'plan'
            ? 'Pre-flight check'
            : mode === 'fly'
              ? 'Live simulation'
              : mode === 'pause'
                ? 'Simulation paused'
                : 'Mission complete'}
        </div>

        <small>{sceneStatus}</small>
      </header>

      {mode === 'plan' && (
        <RiskDashboard
          location={location}
          weather={weather}
          infrastructure={infrastructure}
          wildlife={wildlife}
          airspace={airspace}
          risk={risk}
          loading={loading}
          errors={errors}
          battery={battery}
          onBatteryChange={setBattery}
          onRefresh={() => refreshData(location)}
          onLaunch={launch}
          onAIAnalyze={analyzeWithGemini}
          aiAnalysis={aiAnalysis}
          aiLoading={aiLoading}
          aiError={aiError}
          route={route}
        />
      )}

      {(mode === 'fly' || mode === 'pause') && (
        <aside className="sky-flight-panel">
          <h2>Live telemetry</h2>

          <div className="sky-flight-metrics">
            <div>
              <span>Altitude</span>
              <strong>{telemetry.altitude} m</strong>
            </div>
            <div>
              <span>Speed</span>
              <strong>{telemetry.speed} km/h</strong>
            </div>
            <div>
              <span>Battery</span>
              <strong>{telemetry.battery}%</strong>
            </div>
            <div>
              <span>Flight time</span>
              <strong>{clock(telemetry.time)}</strong>
            </div>
          </div>

          <div className="sky-data-row">
            <span>Distance</span>
            <strong>{telemetry.distance} m</strong>
          </div>
          <div className="sky-data-row">
            <span>Heading</span>
            <strong>{telemetry.heading}°</strong>
          </div>
          <div className="sky-data-row">
            <span>Ground clearance</span>
            <strong>
              {telemetry.clearance === null
                ? 'No data'
                : `${telemetry.clearance} m`}
            </strong>
          </div>
          <div className="sky-data-row">
            <span>Safety events</span>
            <strong>{telemetry.events}</strong>
          </div>

          {telemetry.battery < 20 && (
            <div className="sky-warning">Low battery</div>
          )}

          {telemetry.clearance !== null &&
            telemetry.clearance < 8 && (
              <div className="sky-warning">
                Low ground clearance
              </div>
            )}

          <h3>Flight controls</h3>
          <p className="sky-muted">W and S: forward and back</p>
          <p className="sky-muted">A and D: slide left and right</p>
          <p className="sky-muted">Q and E: down and up</p>
          <p className="sky-muted">Left and right arrows: turn</p>

          <button
            className="sky-button sky-button-launch"
            onClick={togglePause}
          >
            {mode === 'fly' ? 'Pause' : 'Resume'}
          </button>

          <button className="sky-button" onClick={cycleCamera}>
            Camera: {cameraMode.toLowerCase()}
          </button>

          <label className="sky-range-label">
            Chase distance: {zoom} m
            <input
              type="range"
              min="8"
              max="40"
              value={zoom}
              onChange={event => {
                const value = Number(event.target.value)
                zoomRef.current = value
                setZoom(value)
              }}
            />
          </label>

          <button className="sky-button" onClick={endMission}>
            End mission
          </button>
        </aside>
      )}

      {mode === 'report' && report && (
        <aside className="sky-flight-panel">
          <h2>Mission complete</h2>

          <div className="sky-data-row">
            <span>Flight time</span>
            <strong>{clock(report.duration)}</strong>
          </div>
          <div className="sky-data-row">
            <span>Distance</span>
            <strong>{Math.round(report.distance)} m</strong>
          </div>
          <div className="sky-data-row">
            <span>Battery remaining</span>
            <strong>{Math.round(report.battery)}%</strong>
          </div>

          <h3>Safety events</h3>
          {report.events.length ? report.events.map((event, i) => (
            <p className="sky-event" key={i}>
              T+{event.time}s: {event.text}
            </p>
          )) : (
            <p className="sky-muted">No events recorded.</p>
          )}

          <button
            className="sky-button sky-button-launch"
            onClick={() => downloadReport(report)}
          >
            Download PDF report
          </button>

          <button className="sky-button" onClick={resetMission}>
            Plan another flight
          </button>
        </aside>
      )}

      <MissionMap
        ref={mapRef}
        location={location}
        destination={destination}
        infrastructure={infrastructure}
        wildlife={wildlife}
        route={route}
        flightPath={flightPath}
        mode={mode}
        onLocationChange={changeLocation}
        onDestinationChange={setDestination}
      />

      {sceneError && (
        <div className="sky-scene-error">{sceneError}</div>
      )}

      <footer className="sky-footer">
        KnowFlyZone flight simulator. Practice only, not a flight authorization.
        <span>
          Open-Meteo, OpenStreetMap, iNaturalist, Gemini, Cesium
        </span>
      </footer>
    </div>
  )
}
