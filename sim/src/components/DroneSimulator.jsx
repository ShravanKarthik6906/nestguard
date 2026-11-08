
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value))

const DroneSimulator = forwardRef(function DroneSimulator(
  {
    active = false,
    cameraMode = 'CHASE',
    zoom = 12,
    pitch = 0,
    roll = 0,
    throttle = 0.5
  },
  ref
) {
  const containerRef = useRef(null)
  const engineRef = useRef(null)
  const stateRef = useRef({
    active,
    cameraMode,
    zoom,
    pitch,
    roll,
    throttle
  })

  useEffect(() => {
    stateRef.current = {
      active,
      cameraMode,
      zoom,
      pitch,
      roll,
      throttle
    }
  }, [active, cameraMode, zoom, pitch, roll, throttle])

  useImperativeHandle(ref, () => ({
    update(values) {
      stateRef.current = {
        ...stateRef.current,
        ...values
      }
    },

    getState() {
      return { ...stateRef.current }
    }
  }), [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const scene = new THREE.Scene()

    const camera = new THREE.PerspectiveCamera(
      40,
      1,
      0.1,
      200
    )

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true
    })

    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, 2)
    )

    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace

    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'

    container.appendChild(renderer.domElement)

    scene.add(
      new THREE.HemisphereLight(
        0xffffff,
        0x536b80,
        3
      )
    )

    const sunlight = new THREE.DirectionalLight(
      0xffffff,
      3
    )

    sunlight.position.set(6, 10, 8)
    scene.add(sunlight)

    const materials = {
      shell: new THREE.MeshStandardMaterial({
        color: 0x1c2026,
        metalness: 0.65,
        roughness: 0.32
      }),

      metal: new THREE.MeshStandardMaterial({
        color: 0x8a929d,
        metalness: 0.8,
        roughness: 0.25
      }),

      dark: new THREE.MeshStandardMaterial({
        color: 0x2a2f36,
        metalness: 0.5,
        roughness: 0.4
      }),

      propeller: new THREE.MeshStandardMaterial({
        color: 0xe8ebef,
        metalness: 0.3,
        roughness: 0.4,
        side: THREE.DoubleSide
      }),

      green: new THREE.MeshStandardMaterial({
        color: 0x2f9e5b,
        emissive: 0x1f6b3d,
        emissiveIntensity: 1.6
      }),

      red: new THREE.MeshStandardMaterial({
        color: 0xd64545,
        emissive: 0x8f2a2a,
        emissiveIntensity: 1.6
      }),

      lens: new THREE.MeshStandardMaterial({
        color: 0x08111c,
        metalness: 0.6,
        roughness: 0.12
      })
    }

    const drone = new THREE.Group()
    const rotors = []

    scene.add(drone)

    function addBox(parent, size, position, material) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...size),
        material
      )

      mesh.position.set(...position)
      parent.add(mesh)
      return mesh
    }

    function addCylinder(
      parent,
      radius,
      height,
      position,
      material
    ) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(
          radius,
          radius,
          height,
          24
        ),
        material
      )

      mesh.position.set(...position)
      parent.add(mesh)
      return mesh
    }

    // Central fuselage
    addBox(
      drone,
      [1.5, 0.43, 1.9],
      [0, 0, 0],
      materials.shell
    )

    addBox(
      drone,
      [1.12, 0.15, 1.4],
      [0, 0.28, 0],
      materials.metal
    )

    // Forward and rear navigation lights
    addBox(
      drone,
      [0.95, 0.1, 0.14],
      [0, 0.08, -1],
      materials.green
    )

    addBox(
      drone,
      [0.95, 0.1, 0.14],
      [0, 0.08, 1],
      materials.red
    )

    // Underslung camera assembly
    addBox(
      drone,
      [0.4, 0.3, 0.4],
      [0, -0.4, -0.75],
      materials.dark
    )

    addBox(
      drone,
      [0.48, 0.4, 0.42],
      [0, -0.56, -1],
      materials.shell
    )

    const lens = addCylinder(
      drone,
      0.16,
      0.09,
      [0, -0.56, -1.25],
      materials.lens
    )

    lens.rotation.x = Math.PI / 2

    // Landing gear
    for (const x of [-0.6, 0.6]) {
      for (const z of [-0.65, 0.65]) {
        addBox(
          drone,
          [0.11, 0.9, 0.11],
          [x, -0.65, z],
          materials.metal
        )
      }

      addBox(
        drone,
        [0.15, 0.12, 2.3],
        [x, -1.15, 0],
        materials.dark
      )
    }

    // Four motors and propeller assemblies
    const motorPositions = [
      [-1.75, -1.65],
      [1.75, -1.65],
      [-1.75, 1.65],
      [1.75, 1.65]
    ]

    motorPositions.forEach(([x, z], index) => {
      const arm = addBox(
        drone,
        [Math.hypot(x, z), 0.19, 0.19],
        [x / 2, 0.12, z / 2],
        materials.dark
      )

      arm.rotation.y = -Math.atan2(z, x)

      addCylinder(
        drone,
        0.32,
        0.4,
        [x, 0.32, z],
        materials.metal
      )

      addCylinder(
        drone,
        0.24,
        0.1,
        [x, 0.56, z],
        materials.shell
      )

      const rotor = new THREE.Group()
      rotor.position.set(x, 0.68, z)
      drone.add(rotor)

      for (let blade = 0; blade < 4; blade++) {
        const bladePivot = new THREE.Group()
        bladePivot.rotation.y = blade * Math.PI / 2

        addBox(
          bladePivot,
          [0.94, 0.035, 0.15],
          [0.47, 0, 0],
          materials.propeller
        )

        rotor.add(bladePivot)
      }

      addCylinder(
        rotor,
        0.14,
        0.07,
        [0, 0.03, 0],
        materials.dark
      )

      addBox(
        drone,
        [0.18, 0.1, 0.18],
        [x, 0.08, z],
        z < 0 ? materials.green : materials.red
      )

      rotors.push({
        object: rotor,
        direction: index % 2 ? -1 : 1
      })
    })

    function resize() {
      const width = Math.max(1, container.clientWidth)
      const height = Math.max(1, container.clientHeight)

      camera.aspect = width / height
      camera.updateProjectionMatrix()

      renderer.setSize(width, height, false)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    const clock = new THREE.Clock()
    let frame = null

    function animate() {
      frame = requestAnimationFrame(animate)

      const dt = Math.min(clock.getDelta(), 0.05)
      const time = clock.elapsedTime

      const state = stateRef.current

      drone.visible =
        Boolean(state.active) &&
        state.cameraMode !== 'FPV'

      const pitch = clamp(state.pitch || 0, -0.6, 0.6)
      const roll = clamp(state.roll || 0, -0.6, 0.6)

      drone.rotation.x +=
        (pitch - drone.rotation.x) * 0.15

      drone.rotation.z +=
        (-roll - drone.rotation.z) * 0.15

      drone.position.y =
        Math.sin(time * 2) * 0.025

      const rotorSpeed =
        15 + clamp(state.throttle || 0, 0, 1) * 45

      for (const rotor of rotors) {
        rotor.object.rotation.y +=
          rotorSpeed * rotor.direction * dt
      }

      if (state.cameraMode === 'TOP') {
        camera.position.set(0, 14, 0.01)
      } else {
        const factor = clamp(
          (state.zoom || 12) / 12,
          0.7,
          3.5
        )

        camera.position.set(
          0,
          3 * factor,
          10 * factor
        )
      }

      camera.lookAt(0, 0, 0)
      renderer.render(scene, camera)
    }

    animate()

    engineRef.current = {
      scene,
      camera,
      renderer,
      drone
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()

      scene.traverse(object => {
        if (object.isMesh) {
          object.geometry.dispose()
        }
      })

      Object.values(materials).forEach(
        material => material.dispose()
      )

      renderer.dispose()
      renderer.domElement.remove()
      engineRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="drone-overlay"
      aria-label="3D quadcopter visualization"
    />
  )
})

export default DroneSimulator
