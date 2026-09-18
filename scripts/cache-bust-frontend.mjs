import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"

const [distDir, version] = process.argv.slice(2)
if (!distDir || !version) {
    throw new Error("usage: node cache-bust-frontend.mjs <dist-directory> <version>")
}

const textExtensions = new Set([".html", ".js", ".mjs", ".css"])
const assetReference = /(["'])(?!https?:|data:|blob:|\/\/|#)([^"']+?\.(?:js|mjs|css|json|wasm|svg|png|wav))(\?[^"']*)?\1/g

function walk(directory) {
    for (const name of readdirSync(directory)) {
        const path = join(directory, name)
        if (statSync(path).isDirectory()) {
            walk(path)
            continue
        }
        if (!textExtensions.has(extname(path).toLowerCase())) continue

        const original = readFileSync(path, "utf8")
        const updated = original.replace(assetReference, (match, quote, asset, query = "") => {
            if (/(?:^|[?&])v=/.test(query)) return match
            const separator = query ? "&" : "?"
            return `${quote}${asset}${query}${separator}v=${version}${quote}`
        })
        if (updated !== original) writeFileSync(path, updated)
    }
}

walk(distDir)
