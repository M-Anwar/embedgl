import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ViewerStore, type Model } from "./model-store";
import "./styles.css";

const stores = new WeakMap<Model, ViewerStore>();

export default {
    render({ model, el }: { model: Model; el: HTMLElement }) {
        let store = stores.get(model);
        if (!store) { store = new ViewerStore(model); stores.set(model, store); }
        const root = createRoot(el);
        root.render(<App store={store} />);
        return () => root.unmount();
    },
};