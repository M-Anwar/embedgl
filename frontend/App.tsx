import {
    ArrowLeft, ChevronLeft, ChevronRight, CircleDashed, Crosshair, Filter as FilterIcon, Hand, Image as ImageIcon,
    ListFilter, LoaderCircle, Maximize, MousePointer2, Plus, RefreshCw, Search,
    SquareCheck,
    SquareDashedMousePointer,
    Trash2, X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ViewerStore, type Field, type Filter, type Row } from "./model-store";
import { PointRenderer, palette, type Box, type Hover, type SelectionTool } from "./point-renderer";

function IconButton({ title, children, onClick, active = false, disabled = false }: {
    title: string; children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean;
}) {
    return <button type="button" className={`ev-icon ${active ? "is-active" : ""}`} aria-label={title}
        title={title} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

function Preview({ store, index, full = false, className = "" }: {
    store: ViewerStore; index: number; full?: boolean; className?: string;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        setUrl(null); setFailed(false);
        store.image(index, full).then(value => { if (active) setUrl(value); })
            .catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [store, index, full, store.dataset.revision]);
    return <div className={`ev-preview ${className}`}>
        {url && !failed ? <img src={url} alt={`Image for row ${index}`} loading="lazy" onError={() => setFailed(true)} />
            : failed ? <ImageIcon size={18} aria-label="Image unavailable" /> : <ImageIcon size={18} />}
    </div>;
}

function FilterEditor({ store }: { store: ViewerStore }) {
    const [column, setColumn] = useState("");
    const [op, setOp] = useState("contains");
    const [value, setValue] = useState("");
    const [error, setError] = useState("");
    const [facets, setFacets] = useState<string[]>([]);
    const facetId = useRef(`ev-facets-${crypto.randomUUID()}`).current;
    const field = store.dataset.fields.find(candidate => candidate.name === column);
    const operations = (current: Field) => [
        ...(current.kind === "string" ? [{ value: "contains", label: "contains" }] : []),
        { value: "eq", label: "equals" },
        ...(["number", "date"].includes(current.kind) ? [
            { value: "gte", label: "at least" }, { value: "lte", label: "at most" },
        ] : []),
        { value: "in", label: "is one of" }, { value: "is_null", label: "is empty" }, { value: "not_null", label: "is not empty" },
    ];
    useEffect(() => {
        setFacets([]);
        if (!field || field.kind !== "string") return;
        let active = true;
        store.request("facets", { column }).then(reply => {
            if (active) setFacets(reply.message.values.map(String));
        }).catch(() => { });
        return () => { active = false; };
    }, [column, store.dataset.revision]);
    const add = () => {
        if (!field) return;
        try {
            let parsed: unknown = value;
            if (op === "in") {
                parsed = JSON.parse(value);
                if (!Array.isArray(parsed)) throw new Error("Enter a JSON array of values");
            } else if (field.kind === "boolean") parsed = value === "true";
            if (!["is_null", "not_null"].includes(op) && !value) throw new Error("A filter value is required");
            const filter: Filter = { column, op, ...(["is_null", "not_null"].includes(op) ? {} : { value: parsed }) };
            setError(""); void store.applyQuery(store.query.text, [...store.query.filters, filter]);
        } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    };
    return <section className="ev-filter-editor">
        <div className="ev-section-heading"><FilterIcon size={15} /><h3>Filters</h3>
            {store.query.filters.length > 0 && <IconButton title="Clear filters" onClick={() => void store.applyQuery(store.query.text, [])}><Trash2 size={14} /></IconButton>}
        </div>
        <div className="ev-active-filters">{store.query.filters.map((filter, index) => <div className="ev-filter-chip" key={index}>
            <span><strong>{filter.column}</strong><small>{filter.op.replaceAll("_", " ")}{filter.value !== undefined ? ` · ${JSON.stringify(filter.value)}` : ""}</small></span>
            <IconButton title={`Remove filter on ${filter.column}`} onClick={() => void store.applyQuery(store.query.text,
                store.query.filters.filter((_, position) => position !== index))}><X size={14} /></IconButton>
        </div>)}</div>
        {store.dataset.fields.length > 0 ? <form onSubmit={event => { event.preventDefault(); add(); }}>
            <label>Column<select value={column} onChange={event => {
                const next = store.dataset.fields.find(candidate => candidate.name === event.target.value)!;
                setColumn(next.name); setOp(operations(next)[0].value); setValue(next.kind === "boolean" ? "true" : ""); setError("");
            }}><option value="" disabled>Choose column</option>{store.dataset.fields.map(candidate => <option key={candidate.name}>{candidate.name}</option>)}</select></label>
            {field && <>
                <label>Condition<select value={op} onChange={event => setOp(event.target.value)}>{operations(field).map(operation =>
                    <option key={operation.value} value={operation.value}>{operation.label}</option>)}</select></label>
                {!["is_null", "not_null"].includes(op) && <label>Value
                    {field.kind === "boolean" && op !== "in" ? <select value={value || "true"} onChange={event => setValue(event.target.value)}>
                        <option value="true">True</option><option value="false">False</option>
                    </select> : <><input aria-label="Filter value" value={value} onChange={event => setValue(event.target.value)}
                        list={field.kind === "string" && op !== "in" ? facetId : undefined}
                        placeholder={op === "in" ? '["receipt", "invoice"]' : field.kind === "date" ? "2026-11-06" : undefined} />
                        <datalist id={facetId}>{facets.map(candidate => <option key={candidate} value={candidate} />)}</datalist></>}
                </label>}
                <button type="submit" className="ev-command"><Plus size={14} />Add filter</button>
            </>}
        </form> : <div className="ev-muted">No filter columns</div>}
        {error && <div role="alert" className="ev-field-error">{error}</div>}
    </section>;
}

function includesIndex(indices: Uint32Array, target: number) {
    let low = 0, high = indices.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (indices[middle] === target) return true;
        if (indices[middle] < target) low = middle + 1; else high = middle - 1;
    }
    return false;
}

function ResultPane({ store, pinned, pin }: { store: ViewerStore; pinned: number | null; pin: (index: number | null) => void }) {
    const selected = (index: number) => includesIndex(store.selected, index);
    const resultCount = store.resultScope === "selected" ? store.selected.length : store.query.count;
    const [detail, setDetail] = useState<Row | null>(null);
    useEffect(() => {
        setDetail(null);
        if (pinned === null) return;
        let active = true;
        store.request("detail", { index: pinned }).then(reply => {
            if (active) setDetail({ index: pinned, values: reply.message.values });
        }).catch(error => { if (active) store.fail(error); });
        return () => { active = false; };
    }, [store, pinned, store.dataset.revision]);
    const row = detail ?? store.rows.find(candidate => candidate.index === pinned);
    return <aside className="ev-results">
        <div className="ev-section-heading">
            {pinned !== null ? <><IconButton title="Back to results" onClick={() => pin(null)}><ArrowLeft size={16} /></IconButton><h3>Image detail</h3></>
                : <><ListFilter size={15} /><h3>Results</h3><span className="ev-count">{resultCount.toLocaleString()}</span></>}
        </div>
        {pinned !== null ? <div className="ev-detail">
            <Preview store={store} index={pinned} full />
            <button className="ev-command" onClick={() => void store.select(new Uint32Array([pinned]), selected(pinned) ? "remove" : "add")}>
                <SquareCheck size={15} />{selected(pinned) ? "Deselect" : "Select"}
            </button>
            <dl><dt>Row</dt><dd>{pinned}</dd>{row && Object.entries(row.values).map(([key, value]) =>
                <div key={key}><dt>{key}</dt><dd>{value === null ? "—" : String(value)}</dd></div>)}</dl>
        </div> : <>
            <div className="ev-result-scope ev-segment" role="group" aria-label="Results scope">
                <button aria-pressed={store.resultScope === "all"} onClick={() => store.setResultScope("all")}>All</button>
                <button aria-pressed={store.resultScope === "selected"} onClick={() => store.setResultScope("selected")}>
                    Selected ({store.selected.length.toLocaleString()})
                </button>
            </div>
            <div className="ev-result-actions"><button className="ev-command" disabled={store.busy || !store.query.count}
                onClick={() => void store.selectAll()}><SquareCheck size={14} />Select all {store.query.count.toLocaleString()}</button></div>
            <div className="ev-row-list">{store.rows.map((result: Row) => <div className={`ev-row ${selected(result.index) ? "is-selected" : ""}`} key={result.index}>
                <input type="checkbox" aria-label={`Select row ${result.index}`} checked={selected(result.index)}
                    onChange={event => void store.select(new Uint32Array([result.index]), event.target.checked ? "add" : "remove")} />
                <button className="ev-result-open" onClick={() => pin(result.index)} title="Open image details">
                    <Preview store={store} index={result.index} />
                    <span>{Object.entries(result.values).map(([key, value], position) => position < 2 &&
                        <span className={position === 0 ? "ev-row-title" : "ev-row-subtitle"} key={key} title={String(value ?? "")}>{String(value ?? "—")}</span>)}</span>
                </button>
            </div>)}{!store.busy && resultCount === 0 && <div className="ev-empty">
                {store.resultScope === "selected" ? "No selected rows" : "No matching rows"}
            </div>}</div>
            <div className="ev-pagination"><IconButton title="Previous page" disabled={store.offset === 0 || store.busy}
                onClick={() => void store.page(Math.max(0, store.offset - 30))}><ChevronLeft size={16} /></IconButton>
                <span>{resultCount ? `${store.offset + 1}–${Math.min(store.offset + 30, resultCount)}` : "0"}</span>
                <IconButton title="Next page" disabled={store.offset + 30 >= resultCount || store.busy}
                    onClick={() => void store.page(store.offset + 30)}><ChevronRight size={16} /></IconButton></div>
        </>}
    </aside>;
}

export function App({ store }: { store: ViewerStore }) {
    useSyncExternalStore(store.subscribe, store.snapshot);
    const host = useRef<HTMLDivElement>(null);
    const renderer = useRef<PointRenderer | null>(null);
    const [mode, setMode] = useState(store.dataset.modes[0]);
    const [text, setText] = useState(store.query.text);
    const [pointSize, setPointSize] = useState(4);
    const [selecting, setSelecting] = useState<SelectionTool>(false);
    const [showFilters, setShowFilters] = useState(true);
    const [hover, setHover] = useState<Hover | null>(null);
    const [box, setBox] = useState<Box | null>(null);
    const [ready, setReady] = useState(false);
    const [pinned, setPinned] = useState<number | null>(null);
    const geometry = store.geometries.get(mode);

    useEffect(() => store.attach(), [store]);
    useEffect(() => {
        if (!store.dataset.modes.includes(mode)) setMode(store.dataset.modes[0]);
        setPinned(null); setHover(null);
    }, [store.dataset.revision]);
    useEffect(() => { setText(store.query.text); setPinned(null); setHover(null); }, [store.query.revision]);
    useEffect(() => {
        if (text === store.query.text) return;
        const timer = setTimeout(() => void store.applyQuery(text, store.query.filters), 350);
        return () => clearTimeout(timer);
    }, [text, store]);
    useEffect(() => { void store.ensureGeometry(mode); }, [mode, store.dataset.revision]);
    useEffect(() => {
        if (!host.current || !geometry) return;
        let instance: PointRenderer;
        try {
            instance = new PointRenderer(host.current, geometry, mode, {
                hover: setHover, box: setBox, ready: setReady, error: store.fail,
                select: (indices, selectionMode) => void store.select(indices, selectionMode),
            });
            renderer.current = instance;
            instance.setMatches(store.matches); instance.setSelected(store.selected);
            instance.setPointSize(pointSize); instance.setSelecting(selecting);
        } catch (error) { store.fail(error); return; }
        return () => { instance.dispose(); renderer.current = null; };
    }, [geometry, mode]);
    useEffect(() => { renderer.current?.setMatches(store.matches); }, [store.matches]);
    useEffect(() => { renderer.current?.setSelected(store.selected); }, [store.selected]);
    useEffect(() => { renderer.current?.setPointSize(pointSize); }, [pointSize]);
    useEffect(() => { renderer.current?.setSelecting(selecting); setBox(null); }, [selecting]);

    return <div className="ev-root" style={{ height: store.height }}>
        <header className="ev-header"><div className="ev-brand"><Crosshair size={20} /><strong>EmbedGL</strong></div>
            <span className="ev-dataset-count">{store.dataset.count.toLocaleString()} points</span>
            <span className={`ev-live ${store.error ? "is-error" : ""}`}>{store.error ? "Attention" : "Kernel connected"}</span>
        </header>
        <div className="ev-toolbar">
            <IconButton title="Toggle filters" active={showFilters} onClick={() => setShowFilters(!showFilters)}><FilterIcon size={17} /></IconButton>
            <label className="ev-search"><Search size={16} /><input type="search" value={text} placeholder="Search"
                aria-label="Search configured DataFrame columns" disabled={!store.dataset.searchable.length}
                onChange={event => setText(event.target.value)} /></label>
            <div className="ev-segment" role="group" aria-label="Projection dimensions">{store.dataset.modes.map(value =>
                <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value.toUpperCase()}</button>)}</div>
            <span className="ev-toolbar-divider" />
            <IconButton title="Pan and orbit" active={!selecting} onClick={() => setSelecting(false)}><Hand size={17} /></IconButton>
            <IconButton title="Rectangle selection" active={selecting === "rectangle"} onClick={() => setSelecting("rectangle")}><SquareDashedMousePointer size={17} /></IconButton>
            <IconButton title="Circular selection" active={selecting === "circle"} onClick={() => setSelecting("circle")}><CircleDashed size={17} /></IconButton>
            <IconButton title="Reset camera" onClick={() => renderer.current?.fit(false)}><Maximize size={17} /></IconButton>
            <IconButton title="Fit matching points" disabled={!store.matches.length} onClick={() => renderer.current?.fit(true)}><Crosshair size={17} /></IconButton>
            <label className="ev-size">Size<input aria-label="Point size" type="range" min="2" max="12" step="1" value={pointSize}
                onChange={event => setPointSize(Number(event.target.value))} /></label>
        </div>
        {store.error && <div className="ev-error" role="alert"><span>{store.error}</span>
            <IconButton title="Reconnect viewer" onClick={store.reload}><RefreshCw size={16} /></IconButton></div>}
        <div className={`ev-workspace ${showFilters ? "with-filters" : ""}`}>
            {showFilters && <aside className="ev-sidebar"><FilterEditor store={store} />
                {store.dataset.clusters.length > 0 && <section className="ev-legend"><div className="ev-section-heading"><h3>Clusters</h3>
                    <span className="ev-count">{store.dataset.cluster_count.toLocaleString()}</span></div>
                    {store.dataset.clusters.map(cluster => <div key={cluster.code} className="ev-legend-item" title={cluster.label}>
                        <span style={{ background: palette[cluster.code % palette.length] }} />{cluster.label}</div>)}
                    {store.dataset.cluster_count > 200 && <div className="ev-muted">+{store.dataset.cluster_count - 200} clusters</div>}
                </section>}
            </aside>}
            <main className="ev-stage">
                <div className="ev-canvas" ref={host} />
                {box && <div className="ev-selection-box" style={{ ...box, borderRadius: selecting === "circle" ? "50%" : 0 }} />}
                {(!geometry || store.busy) && <div className="ev-loading"><LoaderCircle size={18} className="ev-spin" />
                    {store.busy ? "Updating matches" : store.progress || "Loading coordinates"}</div>}
                {geometry && !store.busy && !store.matches.length && <div className="ev-stage-empty">No matching points</div>}
                <div className="ev-stage-status"><span>{store.matches.length.toLocaleString()} visible</span>
                    <span><MousePointer2 size={12} />{ready ? "Ready" : "Indexing"}</span></div>
                {hover && !box && <div className="ev-hover" aria-label="Nearby images"><div className="ev-section-heading">
                    <h3>{hover.total === 1 ? "1 point" : `${hover.total.toLocaleString()} nearby points`}</h3>
                    <IconButton title="Close image preview" onClick={() => setHover(null)}><X size={14} /></IconButton></div>
                    <div className="ev-hover-grid">{hover.indices.map(index => <button key={index} title={`Open row ${index}`}
                        onClick={() => { setPinned(index); setHover(null); }}><Preview store={store} index={index} /></button>)}</div>
                    {hover.total > 12 && <span className="ev-muted">+{(hover.total - 12).toLocaleString()} more</span>}
                </div>}
            </main>
            <ResultPane store={store} pinned={pinned} pin={setPinned} />
        </div>
        <footer className="ev-footer"><span><span className="ev-selected-dot" />{store.selected.length.toLocaleString()} selected</span>
            <IconButton title="Clear selection" disabled={!store.selected.length} onClick={() => void store.select(new Uint32Array())}><Trash2 size={14} /></IconButton>
            <span className="ev-footer-total">{store.query.count.toLocaleString()} / {store.dataset.count.toLocaleString()} matching</span>
        </footer>
    </div>;
}