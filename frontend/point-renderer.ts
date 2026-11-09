import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Geometry } from "./model-store";
import PickingWorker from "./picking.worker?worker&inline";

export const palette = ["#198875", "#e2658b", "#5c82d5", "#cd9438", "#9677bb", "#46a7bb", "#d5654a", "#6e9950"];
export interface Hover { indices: number[]; total: number; x: number; y: number }
export interface Box { left: number; top: number; width: number; height: number }
export type SelectionTool = false | "rectangle" | "circle";
interface Callbacks {
    hover: (value: Hover | null) => void;
    select: (indices: Uint32Array, mode: string) => void;
    box: (value: Box | null) => void;
    ready: (value: boolean) => void;
    error: (error: unknown) => void;
}

export class PointRenderer {
    private renderer: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
    private controls: OrbitControls;
    private geometry = new THREE.BufferGeometry();
    private material: THREE.ShaderMaterial;
    private worker: Worker;
    private positions: Float32Array;
    private matches: Uint32Array = new Uint32Array();
    private selected: Uint32Array = new Uint32Array();
    private mask: Float32Array;
    private observer: ResizeObserver;
    private animation = 0;
    private projectTimer: ReturnType<typeof setTimeout> | undefined;
    private hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private revision = 0;
    private pickReady = false;
    private dirty = true;
    private disposed = false;
    private width = 1;
    private height = 1;
    private selecting: SelectionTool = false;
    private pointer: { x: number; y: number; mode: string } | null = null;
    private hoverToken = 0;
    private clickToken = -1;
    private clickMode = "replace";
    private abort = new AbortController();

    constructor(private host: HTMLElement, data: Geometry, private mode: string, private callbacks: Callbacks) {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
        this.worker = new PickingWorker();
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.setClearColor("#f1f5f5");
        this.renderer.domElement.setAttribute("aria-label", "Embedding point cloud");
        this.renderer.domElement.setAttribute("role", "img");
        host.appendChild(this.renderer.domElement);
        this.positions = new Float32Array(data.positions.length);
        const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
        for (let offset = 0; offset < data.positions.length; offset++) {
            const axis = offset % 3;
            minimum[axis] = Math.min(minimum[axis], data.positions[offset]);
            maximum[axis] = Math.max(maximum[axis], data.positions[offset]);
        }
        const center = minimum.map((value, axis) => Number.isFinite(value) ? (value + maximum[axis]) / 2 : 0);
        const scale = Math.max(...maximum.map((value, axis) => Number.isFinite(value) ? value - minimum[axis] : 0), 1e-12);
        for (let offset = 0; offset < data.positions.length; offset++) {
            this.positions[offset] = (data.positions[offset] - center[offset % 3]) * 2 / scale;
        }
        const colors = new Uint8Array(data.clusters.length * 3);
        const colorValues = palette.map(value => new THREE.Color(value));
        for (let index = 0; index < data.clusters.length; index++) {
            const color = colorValues[data.clusters[index] % colorValues.length];
            colors[index * 3] = Math.round(color.r * 255);
            colors[index * 3 + 1] = Math.round(color.g * 255);
            colors[index * 3 + 2] = Math.round(color.b * 255);
        }
        this.mask = new Float32Array(data.clusters.length);
        this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
        this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
        this.geometry.setAttribute("state", new THREE.BufferAttribute(this.mask, 1).setUsage(THREE.DynamicDrawUsage));
        this.geometry.computeBoundingSphere();
        this.material = new THREE.ShaderMaterial({
            uniforms: { pointSize: { value: 4 * this.renderer.getPixelRatio() } },
            vertexShader: `
        attribute vec3 color;
        attribute float state;
        uniform float pointSize;
        varying vec3 pointColor;
        varying float pointState;
        void main() {
          pointState = state;
          pointColor = state > 1.5 ? vec3(0.98, 0.68, 0.14) : color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = pointSize + (state > 1.5 ? 2.0 : 0.0);
          if (state < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
            fragmentShader: `
        varying vec3 pointColor;
        varying float pointState;
        void main() {
          if (pointState < 0.5 || length(gl_PointCoord - 0.5) > 0.5) discard;
          gl_FragColor = vec4(pointColor, 1.0);
          #include <colorspace_fragment>
        }`,
        });
        this.scene.add(new THREE.Points(this.geometry, this.material));
        this.camera = mode === "2d"
            ? new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.01, 100)
            : new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableRotate = mode === "3d";
        this.controls.screenSpacePanning = true;
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.15;
        if (mode === "2d") this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        this.controls.addEventListener("change", this.changed);
        this.worker.onmessage = this.workerMessage;
        this.worker.onerror = event => callbacks.error(new Error(event.message || "Point-index worker failed"));
        const workerPositions = this.positions.slice();
        this.worker.postMessage({ op: "positions", positions: workerPositions }, [workerPositions.buffer]);
        this.observer = new ResizeObserver(this.resize); this.observer.observe(host);
        const canvas = this.renderer.domElement;
        const options = { signal: this.abort.signal };
        canvas.addEventListener("pointerdown", this.pointerDown, options);
        canvas.addEventListener("pointermove", this.pointerMove, options);
        canvas.addEventListener("pointerup", this.pointerUp, options);
        canvas.addEventListener("pointercancel", this.pointerCancel, options);
        canvas.addEventListener("pointerleave", this.pointerLeave, options);
        canvas.addEventListener("webglcontextlost", event => {
            event.preventDefault(); callbacks.error(new Error("WebGL context lost. Reconnect the viewer to restore rendering."));
        }, options);
        this.fit(false); this.resize(); this.tick();
    }

    private workerMessage = ({ data }: MessageEvent) => {
        if (data.revision !== this.revision || this.disposed) return;
        if (data.op === "ready") { this.pickReady = true; this.callbacks.ready(true); }
        if (data.op === "hover" && data.token === this.hoverToken) {
            if (data.token === this.clickToken) {
                this.callbacks.select(new Uint32Array(data.indices.slice(0, 1)), this.clickMode);
                this.clickToken = -1;
            } else this.callbacks.hover(data.indices.length ? data : null);
        }
        if (data.op === "rectangle" || data.op === "circle") this.callbacks.select(data.indices, data.mode);
    };

    private tick = () => {
        if (this.disposed) return;
        this.controls.update();
        if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
        this.animation = requestAnimationFrame(this.tick);
    };

    private changed = () => {
        this.dirty = true; this.pickReady = false; this.revision++; this.hoverToken++;
        this.callbacks.ready(false); this.callbacks.hover(null);
        clearTimeout(this.projectTimer);
        this.projectTimer = setTimeout(this.project, 160);
    };

    private project = () => {
        if (this.disposed) return;
        this.camera.updateMatrixWorld();
        const matrix = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.worker.postMessage({
            op: "project", matrix: matrix.elements, width: this.width, height: this.height,
            revision: this.revision
        });
    };

    private resize = () => {
        this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(this.width, this.height);
        const aspect = this.width / this.height;
        if (this.camera instanceof THREE.PerspectiveCamera) this.camera.aspect = aspect;
        else {
            this.camera.left = -1.3 * aspect; this.camera.right = 1.3 * aspect;
            this.camera.top = 1.3; this.camera.bottom = -1.3;
        }
        this.camera.updateProjectionMatrix(); this.changed();
    };

    setMatches(matches: Uint32Array) {
        this.matches = matches;
        const copy = matches.slice();
        this.worker.postMessage({ op: "matches", matches: copy }, [copy.buffer]);
        this.updateMask(); this.changed();
    }

    setSelected(selected: Uint32Array) { this.selected = selected; this.updateMask(); }

    private updateMask() {
        this.mask.fill(0);
        for (const index of this.matches) this.mask[index] = 1;
        for (const index of this.selected) if (this.mask[index]) this.mask[index] = 2;
        this.geometry.getAttribute("state").needsUpdate = true; this.dirty = true;
    }

    setPointSize(size: number) { this.material.uniforms.pointSize.value = size * this.renderer.getPixelRatio(); this.dirty = true; }
    setSelecting(value: SelectionTool) {
        this.pointerCancel();
        this.selecting = value; this.controls.enabled = !value;
        this.renderer.domElement.style.cursor = value ? "crosshair" : "grab";
    }

    fit(results: boolean) {
        const minimum = new THREE.Vector3(Infinity, Infinity, Infinity), maximum = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        const point = new THREE.Vector3();
        if (results && this.matches.length) {
            for (const row of this.matches) {
                point.fromArray(this.positions, row * 3); minimum.min(point); maximum.max(point);
            }
        } else { minimum.set(-1, -1, -1); maximum.set(1, 1, 1); }
        const center = minimum.clone().add(maximum).multiplyScalar(0.5);
        const size = maximum.clone().sub(minimum);
        const radius = Math.max(size.x, size.y, this.mode === "3d" ? size.z : 0, 0.02) / 2;
        this.controls.target.copy(center);
        if (this.camera instanceof THREE.OrthographicCamera) {
            this.camera.position.copy(center).add(new THREE.Vector3(0, 0, 5));
            this.camera.zoom = Math.min(1.3 / radius, 1.3 * this.width / this.height / radius) / 1.12;
        } else {
            const angle = THREE.MathUtils.degToRad(this.camera.fov / 2);
            const distance = radius * 1.7 / Math.tan(angle) / Math.min(this.width / this.height, 1);
            this.camera.position.copy(center).add(new THREE.Vector3(0.55, 0.35, 1).normalize().multiplyScalar(distance));
            this.camera.near = Math.max(distance / 1000, 0.00001); this.camera.far = Math.max(distance * 100, 100);
        }
        this.camera.lookAt(center); this.camera.updateProjectionMatrix(); this.controls.update(); this.changed();
    }

    private location(event: PointerEvent) {
        const rectangle = this.renderer.domElement.getBoundingClientRect();
        return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
    }

    private pointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const location = this.location(event);
        clearTimeout(this.hoverTimer); this.hoverToken++; this.callbacks.hover(null);
        this.pointer = { ...location, mode: event.altKey ? "remove" : event.shiftKey ? "add" : "replace" };
        if (this.selecting) this.renderer.domElement.setPointerCapture(event.pointerId);
    };

    private pointerMove = (event: PointerEvent) => {
        const { x, y } = this.location(event);
        if (this.pointer) {
            if (this.selecting === "circle") {
                const radius = Math.hypot(x - this.pointer.x, y - this.pointer.y);
                this.callbacks.box({
                    left: this.pointer.x - radius, top: this.pointer.y - radius,
                    width: radius * 2, height: radius * 2
                });
            } else if (this.selecting) this.callbacks.box({
                left: Math.min(x, this.pointer.x), top: Math.min(y, this.pointer.y),
                width: Math.abs(x - this.pointer.x), height: Math.abs(y - this.pointer.y)
            });
            return;
        }
        if (!this.pickReady) return;
        clearTimeout(this.hoverTimer);
        const token = ++this.hoverToken;
        this.hoverTimer = setTimeout(() => this.worker.postMessage({
            op: "hover", x, y, radius: 12,
            revision: this.revision, token
        }), 65);
    };

    private pointerUp = (event: PointerEvent) => {
        const pointer = this.pointer; this.pointer = null; this.callbacks.box(null);
        if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
        if (!pointer || !this.pickReady) return;
        const { x, y } = this.location(event);
        if (this.selecting === "circle") {
            this.worker.postMessage({
                op: "circle", revision: this.revision, x: pointer.x, y: pointer.y,
                radius: Math.hypot(x - pointer.x, y - pointer.y), mode: pointer.mode
            });
        } else if (Math.hypot(x - pointer.x, y - pointer.y) < 4) {
            this.clickToken = ++this.hoverToken; this.clickMode = pointer.mode;
            this.worker.postMessage({ op: "hover", x, y, radius: 12, revision: this.revision, token: this.clickToken });
        } else if (this.selecting) {
            this.worker.postMessage({
                op: "rectangle", revision: this.revision, minX: Math.min(x, pointer.x),
                minY: Math.min(y, pointer.y), maxX: Math.max(x, pointer.x), maxY: Math.max(y, pointer.y), mode: pointer.mode
            });
        }
    };

    private pointerCancel = () => { this.pointer = null; this.callbacks.box(null); };
    private pointerLeave = () => { clearTimeout(this.hoverTimer); };

    dispose() {
        this.disposed = true; this.abort.abort(); this.observer.disconnect();
        cancelAnimationFrame(this.animation); clearTimeout(this.projectTimer); clearTimeout(this.hoverTimer);
        this.controls.dispose(); this.worker.terminate(); this.geometry.dispose(); this.material.dispose();
        this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
    }
}