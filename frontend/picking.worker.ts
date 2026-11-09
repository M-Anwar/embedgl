import KDBush from "kdbush";

let positions = new Float32Array();
let matches = new Uint32Array();
let projected = new Float32Array();
let rows = new Uint32Array();
let tree: KDBush | undefined;
let revision = 0;

self.onmessage = ({ data }) => {
    if (data.op === "positions") { positions = data.positions; return; }
    if (data.op === "matches") { matches = data.matches; return; }
    if (data.op === "project") {
        const matrix: number[] = data.matrix;
        const points: number[] = [];
        const indices: number[] = [];
        for (const row of matches) {
            const offset = row * 3;
            const positionX = positions[offset], positionY = positions[offset + 1], positionZ = positions[offset + 2];
            const clipW = matrix[3] * positionX + matrix[7] * positionY + matrix[11] * positionZ + matrix[15];
            if (clipW <= 0) continue;
            const clipX = (matrix[0] * positionX + matrix[4] * positionY + matrix[8] * positionZ + matrix[12]) / clipW;
            const clipY = (matrix[1] * positionX + matrix[5] * positionY + matrix[9] * positionZ + matrix[13]) / clipW;
            const clipZ = (matrix[2] * positionX + matrix[6] * positionY + matrix[10] * positionZ + matrix[14]) / clipW;
            if (Math.abs(clipX) > 1 || Math.abs(clipY) > 1 || Math.abs(clipZ) > 1) continue;
            points.push((clipX + 1) * data.width / 2, (1 - clipY) * data.height / 2, clipZ);
            indices.push(row);
        }
        projected = new Float32Array(points); rows = new Uint32Array(indices);
        tree = new KDBush(rows.length, 64, Float32Array);
        for (let index = 0; index < rows.length; index++) tree.add(projected[index * 3], projected[index * 3 + 1]);
        tree.finish(); revision = data.revision;
        self.postMessage({ op: "ready", revision });
    } else if (data.op === "hover" && tree && data.revision === revision) {
        const candidates = tree.within(data.x, data.y, data.radius);
        candidates.sort((first, second) => {
            const distance = (index: number) => (projected[index * 3] - data.x) ** 2 + (projected[index * 3 + 1] - data.y) ** 2;
            return distance(first) - distance(second) || projected[first * 3 + 2] - projected[second * 3 + 2] || rows[first] - rows[second];
        });
        self.postMessage({
            op: "hover", revision, token: data.token, x: data.x, y: data.y,
            indices: candidates.slice(0, 12).map(index => rows[index]), total: candidates.length
        });
    } else if ((data.op === "rectangle" || data.op === "circle") && tree && data.revision === revision) {
        const found = data.op === "circle"
            ? tree.within(data.x, data.y, data.radius)
            : tree.range(data.minX, data.minY, data.maxX, data.maxY);
        const indices = new Uint32Array(found.map(index => rows[index]));
        self.postMessage({ op: data.op, revision, indices, mode: data.mode }, { transfer: [indices.buffer] });
    }
};