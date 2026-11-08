
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'

import * as maplibregl from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import 'maplibre-gl/dist/maplibre-gl.css'

const EMPTY = {
  type: 'FeatureCollection',
  features: []
}

const MAP_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'osm-background',
      type: 'raster',
      source: 'osm'
    }
  ]
}

function lineFeature(points) {
  return {
    type: 'FeatureCollection',
    features: points.length >= 2
      ? [{
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: points
          }
        }]
      : []
  }
}

function markerElement(text, className) {
  const element = document.createElement('div')
  element.className = className
  element.textContent = text
  return element
}

function updateSource(map, id, data) {
  const source = map.getSource(id)

  if (source) {
    source.setData(data || EMPTY)
  }
}

function addLine(map, id, source, color, width, dash) {
  if (map.getLayer(id)) return

  map.addLayer({
    id,
    type: 'line',
    source,
    paint: {
      'line-color': color,
      'line-width': width,
      'line-opacity': 0.95,
      ...(dash
        ? { 'line-dasharray': dash }
        : {})
    }
  })
}

const MissionMap = forwardRef(function MissionMap(
  {
    location = [-73.6767, 42.7298],
    destination = null,
    infrastructure = null,
    wildlife = null,
    route = null,
    flightPath = [],
    mode = 'plan',
    onLocationChange,
    onDestinationChange
  },
  ref
) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const launchRef = useRef(null)
  const destinationRef = useRef(null)
  const wildlifeRef = useRef([])
  const callbacksRef = useRef({})
  const pickRef = useRef(false)

  const [ready, setReady] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [powerVisible, setPowerVisible] = useState(true)
  const [wildlifeVisible, setWildlifeVisible] = useState(true)
  const [routeVisible, setRouteVisible] = useState(true)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    callbacksRef.current = {
      mode,
      onLocationChange,
      onDestinationChange
    }
  }, [mode, onLocationChange, onDestinationChange])

  useImperativeHandle(ref, () => ({
    getMap: () => mapRef.current,

    flyTo(lon, lat, zoom = 15) {
      mapRef.current?.flyTo({
        center: [lon, lat],
        zoom
      })
    },

    followDrone(lon, lat) {
      mapRef.current?.easeTo({
        center: [lon, lat],
        duration: 250
      })
    },

    resize() {
      mapRef.current?.resize()
    }
  }), [])

  useEffect(() => {
    if (!containerRef.current) return

    // MapLibre GL 6 supports setWorkerUrl().
    // The imported URL is resolved by Vite.
    maplibregl.setWorkerUrl(workerUrl)

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: location,
      zoom: 15,
      attributionControl: true
    })

    mapRef.current = map

    map.addControl(
      new maplibregl.NavigationControl(),
      'top-right'
    )

    const launchMarker = new maplibregl.Marker({
      element: markerElement(
        '',
        'sky-map-launch'
      )
    })
      .setLngLat(location)
      .addTo(map)

    launchRef.current = launchMarker

    function loaded() {
      for (const id of ['power', 'route', 'flight']) {
        if (!map.getSource(id)) {
          map.addSource(id, {
            type: 'geojson',
            data: EMPTY
          })
        }
      }

      addLine(
        map,
        'power-glow',
        'power',
        '#d64545',
        9
      )

      addLine(
        map,
        'power-line',
        'power',
        '#d64545',
        4
      )

      addLine(
        map,
        'route-line',
        'route',
        '#d99a1e',
        4,
        [2, 2]
      )

      addLine(
        map,
        'flight-line',
        'flight',
        '#e8ebef',
        3
      )

      setReady(true)
    }

    function clicked(event) {
      const callbacks = callbacksRef.current

      if (callbacks.mode !== 'plan') return

      const point = [
        event.lngLat.lng,
        event.lngLat.lat
      ]

      if (pickRef.current) {
        callbacks.onDestinationChange?.(point)

        pickRef.current = false
        setPicking(false)
      } else {
        callbacks.onLocationChange?.(point)
      }
    }

    function handleError(event) {
      console.warn(
        'KnowFlyZone simulator minimap:',
        event.error || event
      )
    }

    map.on('load', loaded)
    map.on('click', clicked)
    map.on('error', handleError)

    return () => {
      map.off('load', loaded)
      map.off('click', clicked)
      map.off('error', handleError)

      launchMarker.remove()
      destinationRef.current?.remove()

      wildlifeRef.current.forEach(
        marker => marker.remove()
      )

      map.remove()

      mapRef.current = null
      launchRef.current = null
      destinationRef.current = null
      wildlifeRef.current = []
    }
  }, [])

  useEffect(() => {
    launchRef.current?.setLngLat(location)
  }, [location, ready])

  useEffect(() => {
    const map = mapRef.current

    if (!map || !ready) return

    destinationRef.current?.remove()
    destinationRef.current = null

    if (destination) {
      destinationRef.current = new maplibregl.Marker({
        element: markerElement(
          '',
          'sky-map-destination'
        )
      })
        .setLngLat(destination)
        .addTo(map)
    }
  }, [destination, ready])

  useEffect(() => {
    if (!ready || !mapRef.current) return

    updateSource(
      mapRef.current,
      'power',
      infrastructure?.geojson || EMPTY
    )
  }, [infrastructure, ready])

  useEffect(() => {
    if (!ready || !mapRef.current) return

    const points = Array.isArray(route)
      ? route
      : route?.coordinates || []

    updateSource(
      mapRef.current,
      'route',
      lineFeature(points)
    )
  }, [route, ready])

  useEffect(() => {
    if (!ready || !mapRef.current) return

    updateSource(
      mapRef.current,
      'flight',
      lineFeature(flightPath)
    )
  }, [flightPath, ready])

  useEffect(() => {
    const map = mapRef.current

    if (!ready || !map) return

    for (const id of [
      'power-glow',
      'power-line'
    ]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(
          id,
          'visibility',
          powerVisible ? 'visible' : 'none'
        )
      }
    }
  }, [powerVisible, ready])

  useEffect(() => {
    const map = mapRef.current

    if (!ready || !map) return

    if (map.getLayer('route-line')) {
      map.setLayoutProperty(
        'route-line',
        'visibility',
        routeVisible ? 'visible' : 'none'
      )
    }
  }, [routeVisible, ready])

  useEffect(() => {
    const map = mapRef.current

    if (!ready || !map) return

    wildlifeRef.current.forEach(
      marker => marker.remove()
    )

    wildlifeRef.current = []

    if (!wildlifeVisible) return

    // Only plot wildlife observations that
    // have actual geographic coordinates.
    const observations = wildlife?.observations || []

    for (const item of observations.slice(0, 60)) {
      const lon = Number(item.lon)
      const lat = Number(item.lat)

      if (
        !Number.isFinite(lon) ||
        !Number.isFinite(lat)
      ) {
        continue
      }

      const element = markerElement(
        '',
        'sky-map-wildlife'
      )

      element.title =
        item.name || 'Wildlife observation'

      const marker = new maplibregl.Marker({
        element
      })
        .setLngLat([lon, lat])
        .addTo(map)

      wildlifeRef.current.push(marker)
    }

    return () => {
      wildlifeRef.current.forEach(
        marker => marker.remove()
      )

      wildlifeRef.current = []
    }
  }, [wildlife, wildlifeVisible, ready])

  useEffect(() => {
    const timer = setTimeout(() => {
      mapRef.current?.resize()
    }, 350)

    return () => clearTimeout(timer)
  }, [expanded])

  return (
    <section
      className={`mission-map-panel ${
        expanded ? 'expanded' : ''
      }`}
    >
      <div className="mission-map-header">
        <strong>
          {mode === 'plan'
            ? 'Flight planning map'
            : 'Live flight map'}
        </strong>

        <button
          type="button"
          onClick={() => {
            setExpanded(value => !value)
          }}
        >
          {expanded ? 'Smaller' : 'Bigger'}
        </button>
      </div>

      <div className="mission-map-toolbar">
        <button
          type="button"
          className={
            powerVisible ? 'selected' : ''
          }
          onClick={() => {
            setPowerVisible(value => !value)
          }}
        >
          Power lines
        </button>

        <button
          type="button"
          className={
            wildlifeVisible ? 'selected' : ''
          }
          onClick={() => {
            setWildlifeVisible(value => !value)
          }}
        >
          Wildlife
        </button>

        <button
          type="button"
          className={
            routeVisible ? 'selected' : ''
          }
          onClick={() => {
            setRouteVisible(value => !value)
          }}
        >
          Route
        </button>

        {mode === 'plan' && (
          <button
            type="button"
            className={
              picking ? 'selected' : ''
            }
            onClick={() => {
              const next = !picking

              pickRef.current = next
              setPicking(next)
            }}
          >
            {picking
              ? 'Click the map'
              : 'Set destination'}
          </button>
        )}
      </div>

      <div
        ref={containerRef}
        className="mission-map-canvas"
      />

      <div className="mission-map-footer">
        <span>
          <i className="sky-legend-power" />
          Power lines
        </span>

        <span>
          <i className="sky-legend-route" />
          Candidate route
        </span>

        <span>
          <i className="sky-legend-flight" />
          Flight trail
        </span>
      </div>
    </section>
  )
})

export default MissionMap
