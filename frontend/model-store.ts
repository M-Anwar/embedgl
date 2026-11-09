export interface Model {
    get(key: string): any;
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
    send(content: unknown, callbacks?: unknown, buffers?: ArrayBufferView[]): void;
}

export interface Filter { column: string; op: string; value?: unknown }
export interface Query { text: string; filters: Filter[]; revision: number; count: number }
export interface Field { name: string; kind: "string" | "number" | "date" | "boolean" }
export interface Dataset {
    revision: string;
    count: number;
    modes: string[];
    fields: Field[];
    metadata: string[];
    searchable: string[];
    clusters: { code: number; label: string }[];
    cluster_count: number;
    has_images: boolean;
    bounds: Record<string, { min: number[]; max: number[] }>;
}
export interface Geometry { positions: Float32Array; clusters: Uint32Array }
export interface Row { index: number; values: Record<string, string | number | boolean | null> }
interface Reply { message: any; buffers: DataView[] }

function typed<T extends Float32Array | Uint32Array>(
    view: DataView | undefined, Constructor: { new(buffer: ArrayBuffer): T },
): T {
    if (!view) throw new Error("Missing binary response buffer");
    return new Constructor(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}

export class ViewerStore {
    dataset: Dataset;
    query: Query;
    matches: Uint32Array = new Uint32Array();
    selected: Uint32Array = new Uint32Array();
    geometries = new Map<string, Geometry>();
    rows: Row[] = [];
    offset = 0;
    resultScope: "all" | "selected" = "all";
    error = "";
    busy = true;
    progress = "Connecting to kernel";
    version = 0;
    height: number;
    private listeners = new Set<() => void>();
    private pending = new Map<string, { resolve: (value: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private bindings: [string, (...args: any[]) => void][] = [];
    private geometryTasks = new Map<string, Promise<Geometry | undefined>>();
    private images = new Map<string, { url: string; bytes: number }>();
    private imageTasks = new Map<string, Promise<string | null>>();
    private imageBytes = 0;
    private imageActive = 0;
    private imageQueue: (() => void)[] = [];
    private generation = 0;
    private queryToken = 0;
    private selectionToken = 0;
    private pageToken = 0;
    private refs = 0;

    constructor(readonly model: Model) {
        this.dataset = model.get("dataset");
        this.query = model.get("query");
        this.height = model.get("height");
    }

    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    snapshot = () => this.version;
    notify = () => { this.version++; this.listeners.forEach(listener => listener()); };
    fail = (error: unknown) => { this.error = error instanceof Error ? error.message : String(error); this.notify(); };

    attach() {
        if (this.refs++ === 0) {
            this.bind("msg:custom", this.receive);
            this.bind("change:dataset", this.reload);
            this.bind("change:query", this.refreshQuery);
            this.bind("change:selection_revision", this.refreshSelection);
            this.bind("change:height", () => { this.height = this.model.get("height"); this.notify(); });
            this.reload();
        }
        return () => {
            if (--this.refs !== 0) return;
            this.generation++;
            this.bindings.forEach(([event, handler]) => this.model.off(event, handler));
            this.bindings = [];
            this.queryToken++; this.selectionToken++; this.pageToken++;
            this.pending.forEach(entry => { clearTimeout(entry.timer); entry.reject(new Error("View closed")); });
            this.pending.clear();
            this.images.forEach(image => URL.revokeObjectURL(image.url));
            this.images.clear(); this.imageTasks.clear(); this.imageBytes = 0;
            this.geometries.clear(); this.geometryTasks.clear();
        };
    }

    private bind(event: string, handler: (...args: any[]) => void) {
        this.model.on(event, handler); this.bindings.push([event, handler]);
    }

    private receive = (message: any, buffers: DataView[] = []) => {
        const pending = this.pending.get(message.request_id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.request_id);
        if (message.op === "error") pending.reject(new Error(message.error));
        else if (message.dataset_revision !== this.dataset.revision) pending.reject(new Error("Dataset changed"));
        else pending.resolve({ message, buffers });
    };

    request(op: string, payload: Record<string, unknown> = {}, buffers?: ArrayBufferView[]): Promise<Reply> {
        const request_id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request_id);
                reject(new Error("Kernel did not respond. Keep the notebook kernel running and idle, then reconnect."));
            }, 30000);
            this.pending.set(request_id, { resolve, reject, timer });
            this.model.send({
                version: 1, op, request_id, dataset_revision: this.dataset.revision,
                query_revision: this.query.revision, ...payload
            }, undefined, buffers);
        });
    }

    reload = () => {
        this.generation++;
        const previousModes = [...new Set([...this.geometries.keys(), ...this.geometryTasks.keys()])];
        this.dataset = this.model.get("dataset"); this.query = this.model.get("query");
        this.geometries.clear(); this.geometryTasks.clear();
        this.images.forEach(image => URL.revokeObjectURL(image.url));
        this.images.clear(); this.imageTasks.clear(); this.imageBytes = 0;
        this.matches = new Uint32Array(); this.selected = new Uint32Array(); this.rows = [];
        this.error = ""; this.notify();
        this.refreshQuery(); this.refreshSelection();
        for (const mode of new Set([this.dataset.modes[0], ...previousModes])) {
            if (this.dataset.modes.includes(mode)) void this.ensureGeometry(mode);
        }
    };

    async ensureGeometry(mode: string): Promise<Geometry | undefined> {
        if (this.geometries.has(mode)) return this.geometries.get(mode);
        const active = this.geometryTasks.get(mode);
        if (active) return active;
        const revision = this.dataset.revision;
        const generation = this.generation;
        const count = this.dataset.count;
        const task = (async () => {
            const geometry = { positions: new Float32Array(count * 3), clusters: new Uint32Array(count) };
            let start = 0;
            do {
                this.progress = `Loading coordinates · ${Math.round(start / Math.max(count, 1) * 100)}%`; this.notify();
                const reply = await this.request("geometry", { mode, start });
                if (this.dataset.revision !== revision || generation !== this.generation || !this.refs) return;
                geometry.positions.set(typed(reply.buffers[0], Float32Array), start * 3);
                geometry.clusters.set(typed(reply.buffers[1], Uint32Array), start);
                if (reply.message.end <= start && start < count) throw new Error("Invalid geometry chunk");
                start = reply.message.end;
            } while (start < count);
            if (this.dataset.revision !== revision || generation !== this.generation) return;
            this.geometries.set(mode, geometry); this.progress = ""; this.notify();
            return geometry;
        })();
        this.geometryTasks.set(mode, task);
        try { return await task; }
        catch (error) { if (this.dataset.revision === revision && generation === this.generation && this.refs) this.fail(error); }
        finally { if (this.dataset.revision === revision && generation === this.generation) this.geometryTasks.delete(mode); }
    }

    private async indices(op: "matches" | "selection", current: () => boolean) {
        let start = 0;
        let result: Uint32Array | undefined;
        let revision: number | undefined;
        do {
            const reply = await this.request(op, { start });
            if (!current()) return;
            const nextRevision = op === "matches" ? reply.message.query_revision : reply.message.selection_revision;
            if (revision !== undefined && revision !== nextRevision) return;
            revision = nextRevision;
            if (!result) result = new Uint32Array(reply.message.total);
            result.set(typed(reply.buffers[0], Uint32Array), start);
            if (reply.message.end <= start && start < result.length) throw new Error("Invalid index chunk");
            start = reply.message.end;
        } while (start < result.length);
        return result;
    }

    refreshQuery = async () => {
        const token = ++this.queryToken;
        this.query = this.model.get("query"); this.offset = 0; this.rows = [];
        this.busy = true; this.error = ""; this.matches = new Uint32Array(); this.notify();
        try {
            const matches = await this.indices("matches", () => token === this.queryToken && this.refs > 0);
            if (!matches || token !== this.queryToken) return;
            this.matches = matches; this.busy = false; this.notify();
            await this.page(0);
        } catch (error) { if (token === this.queryToken && this.refs) { this.busy = false; this.fail(error); } }
    };

    refreshSelection = async () => {
        const token = ++this.selectionToken;
        if (this.resultScope === "selected") { this.pageToken++; this.rows = []; this.notify(); }
        try {
            const rows = await this.indices("selection", () => token === this.selectionToken && this.refs > 0);
            if (rows && token === this.selectionToken) {
                this.selected = rows; this.notify();
                if (this.resultScope === "selected") await this.page(this.offset);
            }
        } catch (error) { if (token === this.selectionToken && this.refs) this.fail(error); }
    };

    async page(offset: number) {
        const token = ++this.pageToken;
        const revision = this.query.revision;
        const scope = this.resultScope;
        const selectionRevision = this.model.get("selection_revision");
        try {
            const reply = await this.request("page", { offset, limit: 30, scope, selection_revision: selectionRevision });
            if (token !== this.pageToken || revision !== this.query.revision || scope !== this.resultScope || !this.refs) return;
            if (scope === "selected" && reply.message.selection_revision !== this.model.get("selection_revision")) return;
            this.offset = reply.message.offset; this.rows = reply.message.rows; this.notify();
        } catch (error) {
            if (scope === "selected" && selectionRevision !== this.model.get("selection_revision")) return;
            if (token === this.pageToken && this.refs) this.fail(error);
        }
    }

    setResultScope(scope: "all" | "selected") {
        if (scope === this.resultScope) return;
        this.resultScope = scope; this.offset = 0; this.rows = []; this.notify();
        void this.page(0);
    }

    async applyQuery(text: string, filters: Filter[]) {
        this.error = ""; this.notify();
        try { await this.request("query", { text, filters }); }
        catch (error) { this.fail(error); }
    }

    async select(indices: Uint32Array, mode = "replace") {
        try { await this.request("select", { mode }, [indices]); }
        catch (error) { this.fail(error); }
    }

    async selectAll() {
        try { await this.request("select_all"); }
        catch (error) { this.fail(error); }
    }

    async image(index: number, full = false): Promise<string | null> {
        const revision = this.dataset.revision;
        const generation = this.generation;
        const key = `${revision}:${index}:${full}`;
        const cached = this.images.get(key);
        if (cached) { this.images.delete(key); this.images.set(key, cached); return cached.url; }
        const active = this.imageTasks.get(key);
        if (active) return active;
        const task = (async () => {
            await new Promise<void>(resolve => { this.imageQueue.push(resolve); this.pumpImages(); });
            try {
                if (generation !== this.generation || !this.refs) return null;
                const { message, buffers } = await this.request("image", { index, full });
                if (!message.mime || revision !== this.dataset.revision || generation !== this.generation || !this.refs) return null;
                const bytes = buffers[0].byteLength;
                const raw = buffers[0].buffer.slice(buffers[0].byteOffset, buffers[0].byteOffset + bytes) as ArrayBuffer;
                const url = URL.createObjectURL(new Blob([raw], { type: message.mime }));
                while (this.imageBytes + bytes > 32 * 1024 * 1024 && this.images.size) {
                    const oldestKey = this.images.keys().next().value!;
                    const oldest = this.images.get(oldestKey)!;
                    URL.revokeObjectURL(oldest.url); this.imageBytes -= oldest.bytes; this.images.delete(oldestKey);
                }
                this.images.set(key, { url, bytes }); this.imageBytes += bytes;
                return url;
            } finally { this.imageActive--; this.pumpImages(); }
        })();
        this.imageTasks.set(key, task);
        try { return await task; } finally { this.imageTasks.delete(key); }
    }

    private pumpImages() {
        while (this.imageActive < 4 && this.imageQueue.length) {
            this.imageActive++; this.imageQueue.shift()!();
        }
    }
}