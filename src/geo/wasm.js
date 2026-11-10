/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { base } from '../geo/base.js';
import { newPolygon } from './polygon.js';

const { config } = base;
const factor = config.clipper;

// promise tracking module load so callers can await readiness
let load_promise = null;

export const wasm_ctrl = {
    enable,
    disable,
    // resolves once the module is loaded (or immediately when never
    // requested / already torn down). never rejects: load failures are
    // logged and callers degrade to the JS clipper
    ready() {
        return load_promise || Promise.resolve();
    },
    count: {
        offset: 0,
        union: 0,
        diff: 0
    }
};

function log() {
    console.log(...arguments);
}

function writePolys(view, polys) {
    let pcount = 0;
    for (let poly of polys) {
        pcount += writePoly(view, poly);
    }
    return pcount;
}

/**
 * Flatten a polygon tree into the path list the wasm module expects, using
 * even/odd winding parity so clipper's non-zero fill reproduces the tree.
 *
 * A path's winding is decided by nesting depth, not by "is it an inner":
 * depth 0 (outer) is clockwise, depth 1 (hole) counter-clockwise, depth 2
 * (island inside a hole) clockwise again, and so on. The old code forced
 * *every* inner counter-clockwise, which is only correct one level deep — an
 * island attached inside a pocket (depth 2) landed with hole winding and was
 * subtracted a second time, so the island vanished from the result.
 *
 * @param {DataWriter} view destination
 * @param {Polygon} poly polygon (may have `inner` children)
 * @param {number} [depth] nesting depth; 0 = top level outer
 * @returns {number} number of paths written (self + all descendants)
 */
function writePoly(view, poly, depth = 0) {
    // outers are written clockwise, holes counter-clockwise, alternating with
    // depth. emit points in that order directly instead of reversing the
    // polygon in place: inputs are often shared/cached (shadow stacks) and
    // must not be mutated by a read-only serialization
    let count = 1;
    let points = poly.points;
    let inners = poly.inner;
    let len = points.length;
    let reverse = poly.isClockwise() !== (depth % 2 === 0);
    view.writeU16(len, true);
    for (let i=0; i<len; i++) {
        let point = points[reverse ? len - i - 1 : i];
        view.writeI32((point.x * factor)|0, true);
        view.writeI32((point.y * factor)|0, true);
    }
    if (inners) {
        for (let i=0, il=inners.length; i<il; i++) {
            count += writePoly(view, inners[i], depth + 1);
        }
    }
    return count;
}

function readPoly(view, z) {
    let points = view.readU16(true);
    if (points === 0) return;
    let poly = newPolygon();
    while (points-- > 0) {
        poly.add(view.readI32(true)/factor, view.readI32(true)/factor, z || 0);
    }
    return poly;
}

function readPolys(view, z, out = []) {
    for (;;) {
        let poly = readPoly(view, z);
        if (poly) {
            out.push(poly);
        } else {
            break;
        }
    }
    return out;
}

export function polyOffset(polys, offset, z, clean, simple, minArea) {
    wasm_ctrl.count.offset++;
    let wasm = base.wasm,
        buffer = wasm.shared,
        pcount = writePolys(new DataWriter(wasm.heap, buffer), polys),
        // never hand *simple* to the module: it runs SimplifyPolygons over the
        // whole input set with clipper's default even-odd fill, which turns any
        // overlap between same-winding outers into a hole. the JS path
        // (polygons.js) simplifies one top-level polygon at a time with
        // non-zero fill, so skipping it here keeps parity — ClipperOffset's
        // own union (pftPositive/pftNegative) already merges the paths
        resat = wasm.fn.offset(buffer, pcount, offset * factor, clean, 0),
        out = readPolys(new DataReader(wasm.heap, resat), z);
    return polyNest(out, minArea);
}

export function polyUnion(polys, z) {
    wasm_ctrl.count.union++;
    let wasm = base.wasm,
        buffer = wasm.shared,
        pcount = writePolys(new DataWriter(wasm.heap, buffer), polys),
        resat = wasm.fn.union(buffer, pcount),
        out = readPolys(new DataReader(wasm.heap, resat), z);
    // callers do their own area filtering (see polygons.js union)
    return polyNest(out, 0);
}

export function polyDiff(polysA, polysB, z, AB, BA) {
    wasm_ctrl.count.diff++;
    let wasm = base.wasm,
        buffer = wasm.shared,
        writer = new DataWriter(wasm.heap, buffer),
        pcountA = writePolys(writer, polysA),
        pcountB = writePolys(writer, polysB),
        resat = wasm.fn.diff(buffer, pcountA, pcountB, AB?1:0, BA?1:0, config.clipperClean),
        reader = new DataReader(wasm.heap, resat);
    if (AB) {
        AB.appendAll(polyNest(readPolys(reader, z)));
    }
    if (BA) {
        BA.appendAll(polyNest(readPolys(reader, z)));
    }
}

/**
 * Nest a flat list of clipper output paths into a polygon tree.
 *
 * The module returns paths flat, losing the PolyTree structure the JS clipper
 * path gets from `fromClipperTree`, so nesting has to be reconstructed here.
 * Depth is decided by containment (not winding) so islands inside holes keep
 * working: even depth paths are tops, odd depth paths become inners of their
 * nearest even-depth ancestor — exactly what `fromClipperTree` produces.
 *
 * @param {Polygon[]} polys flat paths from a wasm op
 * @param {number} [minArea] drop paths smaller than this (default 0.1 to
 * match the JS offset path's minArea default)
 * @returns {Polygon[]} top level polygons with nested inners
 */
function polyNest(polys, minArea = 0.1) {
    let flat = minArea ? polys.filter(p => p.area() >= minArea) : polys;
    // largest first so a parent is always seen before its children
    flat.sort((a, b) => b.area() - a.area());
    let count = flat.length;
    if (!count) {
        return flat;
    }
    if (count === 1) {
        return flat;
    }
    let depth = new Array(count).fill(0),
        parent = new Array(count).fill(-1);

    // for each path, find the smallest already-placed path containing it
    for (let i = 0; i < count; i++) {
        let poly = flat[i],
            bounds = poly.bounds,
            best = -1;
        for (let j = 0; j < i; j++) {
            let outer = flat[j];
            if (outer.area() <= poly.area()) continue;
            if (!outer.bounds.contains(bounds)) continue;
            if (!poly.isInside(outer)) continue;
            if (best < 0 || outer.area() < flat[best].area()) {
                best = j;
            }
        }
        if (best >= 0) {
            parent[i] = best;
            depth[i] = depth[best] + 1;
        }
    }

    let tops = [];
    for (let i = 0; i < count; i++) {
        let poly = flat[i];
        poly.parent = null;
        poly.inner = null;
        poly.depth = depth[i];
        if (depth[i] % 2 === 0) {
            tops.push(poly);
            continue;
        }
        // attach a hole to its nearest even-depth ancestor
        let up = parent[i];
        while (up >= 0 && depth[up] % 2 !== 0) {
            up = parent[up];
        }
        if (up >= 0) {
            flat[up].addInner(poly);
        } else {
            tops.push(poly);
        }
    }
    return tops;
}

function readString(pos, len) {
    let view = new DataReader(base.wasm.heap, pos);
    let out = [];
    while (len-- > 0) {
        out.push(String.fromCharCode(view.readU8()));
    }
    return out.join('');
}

export function enable() {
    if (base.wasm || base._wasm) {
        return;
    }
    base._wasm = 'loading';
    load_promise = fetch('/wasm/kiri-geo.wasm')
        .then(response => response.arrayBuffer())
        .then(bytes => WebAssembly.instantiate(bytes, {
            env: {
                debug_string: (len, ptr) => { console.log('wasm', readString(ptr, len)) }
            },
            wasi_snapshot_preview1: {
                // args_get: (count,bufsize) => { return 0 },
                // args_sizes_get: (count,bufsize) => { },
                // environ_get: (count,bufsize) => { return 0 },
                // environ_sizes_get: (count,bufsize) => { },
                proc_exit: (code) => { return code }
            }
        }))
        .then(results => {
            // console.log({enabled: base.wasm});
            delete base._wasm;
            let { module, instance } = results;
            let { exports } = instance;
            let heap = new DataView(exports.memory.buffer);
            let wasm = base.wasm = {
                heap,
                exports,
                memory: exports.memory,
                memmax: exports.memory.buffer.byteLength,
                malloc: exports.mem_get,
                free: exports.mem_clr
            };
            wasm.shared = wasm.malloc(1024 * 1024 * 30),
            wasm.fn = {
                diff: exports.poly_diff,
                union: exports.poly_union,
                offset: exports.poly_offset
            };
            wasm.js = {
                diff: polyDiff,
                union: polyUnion,
                offset: polyOffset
            };
        })
        .catch(e => {
            // allow re-enable attempts and let callers fall back to JS clipper
            delete base._wasm;
            console.log('wasm load failed', e.message || e);
        });
}

export function disable() {
    if (base.wasm) {
        base.wasm.free(base.wasm.shared);
        delete base.wasm;
    }
}
