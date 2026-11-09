import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const sections = ["Third-party licenses for the bundled embedgl frontend.\n"];
for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || entry.dev) continue;
    const directory = path.join(root, location);
    const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const files = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name)).sort();
    if (!files.length) throw new Error(`Missing license text for ${metadata.name}`);
    sections.push(`\n${"=".repeat(72)}\n${metadata.name}@${metadata.version}\nLicense: ${metadata.license}\n`);
    for (const name of files) sections.push(`\n${name}\n${await readFile(path.join(directory, name), "utf8")}\n`);
}
await writeFile(path.join(root, "src/embedgl/THIRD_PARTY_LICENSES.txt"), sections.join(""));