/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { codec } from '../../../core/codec.js';
import { newPoint } from '../../../../geo/point.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { newSlice } from '../../../core/slice.js';
import { Slicer as topo_slicer } from './slicer-topo.js';
import { polygons as POLY } from '../../../../geo/polygons.js';
import { Tool } from '../core/tool.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export class Topo {
    constructor() { }

    async generate(opt = {}) {
        let { state, contour, onupdate, ondone } = opt;
        let { widget, settings, shadow, tabs } = opt.state;

        let { controller, process } = settings,
            { webGPU } = controller,
            { workarea } = state,
            animesh = parseInt(controller.animesh || 100) * 2500,
            axis = contour.axis.toLowerCase(),
            contourX = axis === "x",
            contourY = axis === "y",
            contourM = axis === "merged",
            contourR = axis === "radial",
            bounds = widget.getBoundingBox().clone(),
            tolerance = contour.tolerance,
            flatness = contour.flatness || (tolerance / 100),
            minX = bounds.min.x,
            maxX = bounds.max.x,
            minY = bounds.min.y,
            maxY = bounds.max.y,
            // zBottom priority: per-op numeric ov_botz (already applied to
            // workarea.bottom_z by slice.js) > legacy `bottom` checkbox > 0.
            // ov_botz works without the global camZBottom that `bottom` requires.
            zBottom = (contour.bottom || contour.ov_botz) ? workarea.bottom_z : 0,
            zMin = workarea.bottom_z + 0.0001,
            boundsX = maxX - minX,
            boundsY = maxY - minY,
            inside = contour.inside,
            density = 1 + (contour.reduction || 0),
            resolution = (tolerance ? tolerance : 1 / Math.sqrt(animesh / (boundsX * boundsY))).round(5),
            tool = new Tool(settings, contour.tool),
            toolOffset = tool.generateProfile(resolution).profile,
            toolDiameter = tool.fluteDiameter(),
            toolStep = toolDiameter * contour.step,
            leave = contour.leave || 0,
            maxangle = contour.angle,
            // curvesOnly decimation is axis-bound (push_point tests slope
            // against the x or y delta and drops polylines shorter than a
            // tool step) and cannot follow diagonal radial rays, so it is
            // disabled for radial; the axis-bound decimation is not reworked
            curvesOnly = contourR ? false : contour.curves,
            bridge = contour.bridging || 0,
            stepsX = Math.ceil(boundsX / resolution),
            stepsY = Math.ceil(boundsY / resolution),
            widtopo = widget.topo,
            topoCache = widtopo
                && widtopo.tolerance === tolerance
                && widtopo.diameter === toolDiameter
                ? widtopo : undefined,
            topo = widget.topo = topoCache || {
                axis,
                data: new Float32Array(new SharedArrayBuffer(stepsX * stepsY * 4)),
                stepsX,
                stepsY,
                bounds,
                diameter: toolDiameter,
                resolution,
                tolerance,
                profile: toolOffset,
                widget,
                raster: true,
                slices: null
            },
            data = topo.data,
            newslices = [],
            tabsMax = tabs ? Math.max(...tabs.map(tab => tab.dim.z / 2 + tab.pos.z)) : 0,
            tabsOn = tabs,
            tabHeight = Math.max(process.camTabsHeight + zBottom, tabsMax),
            clipTab = tabsOn ? [] : null,
            clipTo = inside ? shadow.base : POLY.expand(shadow.base, toolDiameter / 2 + resolution * 3),
            partOff = inside ? 0 : toolDiameter / 2 + resolution,
            gridDelta = Math.floor(partOff / resolution),
            debug_clips = true;

        if (contour.clipto) {
            let { stock } = settings;
            let { center, x, y } = stock;
            clipTo.push(newPolygon().centerRectangle(center, x, y));
        }

        // radial ("fan") contouring: a set of vertical secant planes all
        // passing through the stock center (same origin convention as
        // clip-to-stock above), rotated by angleStep degrees. the heightmap
        // below is direction-independent and is shared by every ray.
        const rCenter = settings.stock.center;
        // rays span from an inner start radius to maxR + partOff. default
        // inner radius = tool radius to avoid center crowding where all
        // rays converge; optionally 0 via op param `rinside`
        const rInner = contour.rinside !== undefined ? contour.rinside : toolDiameter / 2;
        // farthest widget corner from the fan center (+ partOff, same
        // expansion as X/Y modes)
        const rMax = Math.max(
            Math.hypot(rCenter.x - minX, rCenter.y - minY),
            Math.hypot(rCenter.x - maxX, rCenter.y - minY),
            Math.hypot(rCenter.x - minX, rCenter.y - maxY),
            Math.hypot(rCenter.x - maxX, rCenter.y - maxY)
        );
        // angular step in degrees between adjacent rays
        const angleStep = (contour.astep > 0.01 && contour.astep <= 90)
            ? contour.astep : 2.5;

        if (tolerance === 0 && !topoCache) {
            console.log(widget.id, 'topo auto tolerance', resolution.round(4));
        }

        // console.log({ resolution, flatness });
        // used by Pocket -> Contour
        this.tolerance = resolution;

        if (tabsOn) {
            clipTab.appendAll(tabs.map(tab => {
                let ctab = POLY.expand([tab.poly], toolDiameter / 2);
                ctab.forEach(ct => ct.z = tab.dim.z / 2 + tab.pos.z);
                return ctab;
            }).flat());
        }

        // debug clipTab and clipTo
        if (debug_clips) {
            const debug = newSlice(-1);
            const output = debug.output();
            if (clipTab) output.setLayer("clip.tab", { line: 0xff0000 }).addPolys(clipTab);
            if (clipTo) output.setLayer("clip.to", { line: 0x00dd00 }).addPolys(clipTo);
            newslices.push(debug);
        }

        // webGPU raster only supports axis-aligned scanlines: skip for
        // merged (existing) and radial (fan of secant rays) contouring
        if (webGPU && !contour.nogpu && !contourM && !contourR) {
            // invert tool Z offset for gpu code
            let toolBounds = new THREE.Box3()
                .expandByPoint({ x: -toolDiameter/2, y: -toolDiameter/2, z: 0 })
                .expandByPoint({ x: toolDiameter/2, y: toolDiameter/2, z: 0 });
            let toolPos = tool.profile.slice();
            for (let i=0; i<toolPos.length; i+= 3) {
                // toolPos[i+2] = -toolPos[i+2];
                toolBounds.expandByPoint({ x: toolPos[i], y: toolPos[i+1], z: toolPos[i+2] });
            }
            let toolData = { positions: toolPos, bounds: toolBounds };

            let vertices = widget.getGeoVertices({ unroll: true, translate: true });
            let wbounds = widget.getBoundingBox();
            if (!inside) {
                wbounds.expandByVector({ x: toolDiameter/2 + resolution, y: toolDiameter/2 + resolution, z: 0 });
            }

            // swap XY vertices (unswap later after polylines generated)
            if (contourY) {
                vertices = vertices.slice();
                for (let i=0; i<vertices.length; i+= 3) {
                    let tmp = vertices[i+1];
                    vertices[i+1] = vertices[i+0];
                    vertices[i+0] = tmp;
                }
                ['min','max'].forEach(ext => {
                    ext = wbounds[ext];
                    let tmp = ext.x;
                    ext.x = ext.y;
                    ext.y = tmp;
                });
            }

            let trace = contour.trace;
            let gpu = await self.get_raster_gpu({
                mode: trace ? "tracing" : "planar",
                resolution
            });
            let xStep = density;
            let yStep = Math.ceil(toolStep / resolution);
            let epsilon = 10e-4;
            // load the pre-generated tool profile
            await gpu.loadTool({
                sparseData: toolData
            });
            // rasterize the terrain to the same resolution
            let terrain = await gpu.loadTerrain({
                triangles: vertices,
                boundsOverride: wbounds
            });
            let { gridWidth, positions } = terrain;
            // generate all scanline points passing tool over terrain
            let output = await gpu.generateToolpaths({
                xStep,
                yStep,
                zFloor: zBottom - 1,
                onProgress(pct) { console.log({ pct }); onupdate(pct/100, 100) }
            });
            gpu.mode = 'tracing';
            // create coastline path around part for tip-to-tip travels
            // convert shadow/clip poly lines to raster float32 array groups
            let paths = POLY.flatten(clipTo).map(poly => poly.points.map(p => [ p.x, p.y ]).flat().toFloat32());
            let coastline = await gpu.generateToolpaths({
                paths,
                step: 1,
                zFloor: zBottom
            });
            this.coastline = coastline.paths.map(arr => newPolygon().fromArray([0,...arr]));
            gpu.terminate();

            let { numScanlines, pointsPerLine, pathData } = output;
            let xmult = xStep * resolution;
            let ymult = yStep * resolution;
            let xoff = wbounds.min.x;
            let yoff = wbounds.min.y;
            let slices = [];
            function calcPoint(x, y, z, tx, ty) {
                let p = newPoint(x, y, z);
                p.tx = tx;
                p.ty = ty;
                return p;
            }
            // for each toolpath, return a point in part space coordinated
            // attach to a polyline, and annotate with terrain coordinates
            // so we can later dertermine if the point is on or off the part
            for (let i=0; i<numScanlines; i++) {
                let lineStart = i * pointsPerLine;
                let lineData = pathData.slice(lineStart, lineStart + pointsPerLine);
                let points = Array.from(lineData).map((v,j) => calcPoint(j * xmult + xoff, i * ymult + yoff, v, j * xStep, i * yStep));
                let slice = newSlice(i);
                let poly = newPolygon().setOpen();
                let lines = [ ];
                // track z co-planar skipped points for latent emission
                let skip = 0;
                let lp;
                for (let p of points) {
                    // detect points where no rays intersect the part (off part)
                    if (inside && positions[p.ty * gridWidth + p.tx] < zBottom - epsilon) {
                        if (poly.length > 1) {
                            lines.push(poly);
                            poly = newPolygon().setOpen();
                        } else if (poly.length === 1) {
                            poly = newPolygon().setOpen();
                        }
                        lp = undefined;
                        skip = 0;
                        continue;
                    }
                    // off part but we want to return zBottom (outside)
                    if (p.z < zBottom - epsilon) {
                        lp = p;
                        if (poly.length === 0) {
                            skip++;
                            continue;
                        }
                        if (poly.length > 1) {
                            skip = 0;
                            p.z = zBottom;
                            poly.push(p);
                            lines.push(poly);
                            poly = newPolygon().setOpen();
                            continue;
                        }
                    } else if (lp && skip && poly.length === 0) {
                        // latent/last point output
                        lp.z = zBottom;
                        poly.push(lp);
                    }
                    poly.push(lp = p);
                    skip = 0;
                }
                // require two points or more
                if (poly.length > 1) {
                    lines.push(poly);
                }
                // fixup/swap when contouring along Y
                if (contourY) {
                    for (let poly of lines)
                    for (let p of poly.points) {
                        p.swapXY();
                    }
                }
                // raise output points when inside tab boundaries
                if (tabsOn && clipTab.length)
                for (let poly of lines) {
                    for (let p of poly.points) {
                        for (let clip of clipTab) {
                            if (p.z < clip.z && p.isInPolygon(clip)) {
                                p.z = clip.z;
                                break;
                            }
                        }
                    }
                }
                // drop interior points along a continuous slope
                for (let poly of lines) {
                    let { points } = poly;
                    if (points.length < 2) continue;
                    let merged = [ points[0] ];
                    let lastP = points[0];
                    let latent = null;
                    let lastSlope = undefined;
                    for (let i=1; i<points.length; i++) {
                        let newP = points[i];
                        const dl = (newP.x - lastP.x) || (newP.y - lastP.y);
                        const dz = newP.z - lastP.z;
                        const slope = Math.atan2(dz, dl);
                        if (curvesOnly && Math.abs(dz) < flatness) {
                            // end current segment with latent if present
                            if (latent) {
                                merged.push(latent);
                                latent = null;
                            }
                            // add empty points as path separators
                            merged.push(undefined);
                            lastSlope = undefined;
                        } else if (lastSlope !== undefined && Math.abs(lastSlope - slope) < flatness) {
                            latent = newP;
                        } else {
                            if (latent) {
                                merged.push(latent);
                                latent = null;
                            }
                            merged.push(newP);
                            lastSlope = slope;
                        }
                        lastP = newP;
                    }
                    // add final latent point if present
                    if (latent && merged.peek() !== latent) {
                        merged.push(latent);
                    }
                    poly.points = merged;
                }
                // drop flat regions when enabled
                if (curvesOnly) {
                    let nulines = [];
                    for (let poly of lines) {
                        let { points } = poly;
                        let newp = [];
                        for (let p of points) {
                            if (p) {
                                newp.push(p);
                            } else if (newp.length) {
                                nulines.push(newPolygon(newp).setOpen());
                                newp = [];
                            }
                        }
                        nulines.push(newPolygon(newp).setOpen());
                    }
                    lines = nulines.filter(p => p.perimeter() > toolStep);
                }
                slice.camLines = lines;
                slices.push(slice);
                if (inside) {
                    onupdate(i, numScanlines);
                }
            }
            ondone(slices);
            return this;
        }

        const probe = this.probe = new Probe({
            profile: toolOffset,
            data,
            stepsX,
            stepsY,
            boundsX,
            boundsY,
            minX,
            minY,
            zMin
        });

        const { toolAtZ, toolAtXY, zAtXY } = probe;

        this.toolAtZ = toolAtZ;
        this.toolAtXY = toolAtXY;
        this.zAtXY = zAtXY;

        const trace = this.trace = new Trace(probe, {
            curvesOnly,
            maxangle,
            flatness,
            bridge,
            contourX,
            merged: contourM
        });

        if (topo.raster) {
            const box = topo.box = new THREE.Box2();

            const params = {
                resolution,
                curvesOnly,
                flatness,
                stepsY,
                minY,
                maxY,
                zMin,
                data,
                box
            };

            onupdate(0, 1, "raster");
            await this.raster(widget, params, (i, l, p) => {
                onupdate(i / 2, l, p);
            });
            topo.raster = false;
        }

        await this.contour({
            box: topo.box,
            minX,
            maxX,
            minY,
            maxY,
            stepsX,
            stepsY,
            boundsX,
            boundsY,
            partOff,
            gridDelta,
            resolution,
            toolStep,
            contourX,
            contourY,
            contourM,
            contourR,
            center: { x: rCenter.x, y: rCenter.y },
            rInner,
            rMax,
            angleStep,
            density,
            clipTo,
            clipTab,
            clipTabZ: clipTab ? clipTab.map(t => t.z) : undefined,
            tabHeight,
            newslices,
            leave
        }, (i, l, p) => {
            onupdate(l / 2 + i / 2, l, p);
        });

        ondone(newslices);

        return this;
    }

    async raster(widget, params, onupdate) {
        const { resolution } = params;
        const { box } = params;
        const { dispatch, minions } = self.kiri_worker;

        const vertices = widget.getGeoVertices({ unroll: true, translate: true }).toShared();
        const range = { min: Infinity, max: -Infinity };

        // swap XZ in shared array
        for (let i = 0, l = vertices.length; i < l; i += 3) {
            const x = vertices[i];
            const z = vertices[i + 2];
            vertices[i] = z;
            vertices[i + 2] = x;
            range.min = Math.min(range.min, x);
            range.max = Math.max(range.max, x);
        }

        const shards = Math.ceil(Math.min(25, vertices.length / 27000));
        const step = (range.max - range.min) / shards;

        let slices = [];
        let index = 0;
        let slice = { min: range.min, max: range.min + step, index };
        for (let z = range.min; z < range.max; z += resolution) {
            if (z > slice.max) {
                slices.push(slice);
                slice = { min: z, max: z + step, index };
            }
            index++;
        }
        slices.push(slice);
        // console.log({ shards, range, step, slices });

        let complete = 0;
        // define sharded ranges
        if (minions.running > 1) {

            dispatch.putCache({ key: widget.id, data: vertices }, {
                done: data => {
                    // console.log({ put_cache_done: data });
                }
            });

            let promises = slices.map(slice => {
                return new Promise(resolve => {
                    minions.queue({
                        cmd: "topo_raster",
                        id: widget.id,
                        params,
                        slice
                    }, data => {
                        resolve(data);
                        onupdate(++complete, slices.length, "raster");
                    });
                });
            });

            // merge boxes for all rasters for contouring clipping
            (await Promise.all(promises))
                .map(rec => rec.box)
                .map(box => new THREE.Box2(
                    new THREE.Vector2(box.min.x, box.min.y),
                    new THREE.Vector2(box.max.x, box.max.y)
                ))
                .map(box2 => {
                    box.union(box2);
                    return box2;
                });

            dispatch.clearCache({}, {
                done: data => {
                    // console.log({ clear_cache_done: data });
                }
            });

        } else {

            // iterate over shards, merge output
            // const output = [];
            for (let slice of slices) {
                new topo_slicer(slice.index)
                    .setFromArray(vertices, slice)
                    .slice(resolution)
                    .map(rec => {

                        const slice = newSlice(rec.z);
                        slice.index = rec.index;
                        slice.lines = rec.lines;
                        for (let line of rec.lines) {
                            const { p1, p2 } = line;
                            if (!p1.swapped) { p1.swapXZ(); p1.swapped = true }
                            if (!p2.swapped) { p2.swapXZ(); p2.swapped = true }
                        }

                        raster_slice({
                            ...params,
                            box,
                            lines: rec.lines,
                            gridx: rec.index,
                            slice
                        });

                        return slice;
                    });
                onupdate(++complete, slices.length, "raster");
            }

        }
    }

    async contour(params, onupdate) {
        const trace = this.trace;
        const concurrent = self.kiri_worker.minions.running;

        const { minX, maxX, minY, maxY, boundsX, boundsY, stepsX, stepsY } = params;
        const { gridDelta, resolution, density, partOff, toolStep, contourX, contourY, contourM, contourR } = params;
        const { clipTo, clipTab, clipTabZ, tabHeight, newslices, leave } = params;
        const { center, rInner, rMax, angleStep } = params;

        let stepsTaken = 0,
            stepsTotal = 0;

        if (contourX) {
            stepsTotal += ((maxY - minY + partOff * 2) / toolStep) | 0;
        }

        if (contourY || contourM) {
            stepsTotal += ((maxX - minX + partOff * 2) / toolStep) | 0;
        }

        // merged runs BOTH families (rows + columns): count the row family too
        if (contourM) {
            stepsTotal += ((maxY - minY + partOff * 2) / toolStep) | 0;
        }

        // radial counts rays (one trace per angular step)
        if (contourR) {
            stepsTotal += Math.ceil(360 / angleStep);
        }

        if (stepsTotal === 0) {
            return;
        }

        const box = params.box.clone().expandByVector(new THREE.Vector3(
            partOff, partOff, 0
        ));

        trace.init({
            box,
            leave,
            clipTo,
            clipTab,
            clipTabZ,
            tabHeight,
            resolution,
            concurrent,
            density,
            // merged X+Y contouring needs both raster geometries
            // (minX/boundsX/partOff let row paths locate the column family)
            minX,
            boundsX,
            partOff,
            minY,
            boundsY,
            stepsX,
            stepsY,
            gridDelta,
            toolStep
        });

        let resolver;
        let pcount = 0;
        let slicesY = [];
        let slicesX = [];
        let slicesR = [];
        let promise = new Promise(resolve => {
            resolver = () => {
                // sort output slices (required for async)
                slicesY.sort((a, b) => a.z - b.z);
                slicesX.sort((a, b) => a.z - b.z);
                // radial slices carry the ray angle in z
                slicesR.sort((a, b) => a.z - b.z);
                newslices.appendAll(slicesY);
                newslices.appendAll(slicesX);
                newslices.appendAll(slicesR);
                resolve();
            }
        });
        let inc = () => { pcount++ };
        let dec = () => { if (--pcount === 0 && concurrent) resolver() };

        if (contourM) {
            // merged X+Y contouring: emit BOTH raster families as one op.
            // X-direction rows remove the stairs Y-columns leave on steep
            // x-slopes (sphere silhouette at extreme X); Y-direction columns
            // remove the stairs rows leave on steep y-slopes. where the two
            // families share a sampling point, each takes the lower of the
            // two candidate z values so the shallower family does not re-cut
            // above the deeper one. the combined cut matches running both
            // axis passes sequentially, at the time cost of two passes.
            onupdate(0, stepsTotal, "contour merged");
            const rowStep = resolution * density;
            // X-direction rows (slices per Y), same sampling as contourX
            for (let y = minY - partOff; y <= maxY + partOff; y += toolStep) {
                if (y < box.min.y || y > box.max.y) continue;
                const gridy = Math.round(((y - minY) / boundsY) * stepsY);
                // locate this row between two Y-column sample points
                // (column sample grid indices, matching crossY_sync stepping)
                const rely = y - (minY - partOff);
                const vi = Math.floor(rely / rowStep);
                inc();
                trace.crossM({
                    dir: "x",
                    from: minX - partOff,
                    to: maxX + partOff,
                    y,
                    gridx: -gridDelta,
                    gridy,
                    altT: (rely - vi * rowStep) / rowStep,
                    altA: -gridDelta + vi * density,
                    altB: -gridDelta + (vi + 1) * density
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(y);
                        slice.camLines = segments;
                        slice.mergedDir = "x";
                        slicesX.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour merged");
                    dec();
                });
            }
            // Y-direction columns (slices per X), same sampling as contourY
            for (let x = minX - partOff; x <= maxX + partOff; x += toolStep) {
                if (x < box.min.x || x > box.max.x) continue;
                const gridx = Math.round(((x - minX) / boundsX) * stepsX);
                // locate this column between two X-raster row vertices
                // (row vertex grid indices, matching crossX_sync stepping)
                const relx = x - (minX - partOff);
                const vj = Math.floor(relx / rowStep);
                inc();
                trace.crossM({
                    dir: "y",
                    from: minY - partOff,
                    to: maxY + partOff,
                    x,
                    gridx,
                    gridy: -gridDelta,
                    altT: (relx - vj * rowStep) / rowStep,
                    altA: -gridDelta + vj * density,
                    altB: -gridDelta + (vj + 1) * density
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(x);
                        slice.camLines = segments;
                        slice.mergedDir = "y";
                        slicesY.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour merged");
                    dec();
                });
            }
        }

        if (contourR) {
            // radial fan: one trace per vertical secant plane through the
            // stock center, rotated by angleStep degrees. slice.z = ray
            // angle (sorts correctly for layer ordering / filter naming).
            // arc stepover between adjacent rays is angleStep * r and grows
            // with radius (inherent to radial strategies); the step tightens
            // toward the center and widens toward the silhouette.
            onupdate(0, stepsTotal, "contour radial");
            const nrays = Math.ceil(360 / angleStep);
            const r0 = rInner;
            const r1 = rMax + partOff;
            for (let ri = 0; ri < nrays; ri++) {
                const angle = ri * 360 / nrays;
                const rad = angle * DEG2RAD;
                inc();
                trace.crossR({
                    cx: center.x,
                    cy: center.y,
                    cos: Math.cos(rad),
                    sin: Math.sin(rad),
                    from: r0,
                    to: r1
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(angle);
                        slice.camLines = segments;
                        slicesR.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour radial");
                    dec();
                });
            }
        }

        if (contourY) {
            onupdate(0, stepsTotal, "contour y");
            // emit slice per X
            for (let x = minX - partOff; x <= maxX + partOff; x += toolStep) {
                if (x < box.min.x || x > box.max.x) continue;
                const gridx = Math.round(((x - minX) / boundsX) * stepsX);
                const gridy = -gridDelta;
                inc();
                trace.crossY({
                    from: minY - partOff,
                    to: maxY + partOff,
                    x,
                    gridx,
                    gridy
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(x);
                        slice.camLines = segments;
                        slicesY.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour y");
                    dec();
                });
            }
        }

        if (contourX) {
            // emit slice per Y
            onupdate(0, stepsTotal, "contour x");
            for (let y = minY - partOff; y <= maxY + partOff; y += toolStep) {
                if (y < box.min.y || y > box.max.y) continue;
                const gridy = Math.round(((y - minY) / boundsY) * stepsY);
                const gridx = -gridDelta;
                inc();
                trace.crossX({
                    from: minX - partOff,
                    to: maxX + partOff,
                    y,
                    gridx,
                    gridy
                }, segments => {
                    if (segments.length > 0) {
                        let slice = newSlice(y);
                        slice.camLines = segments;
                        slicesX.push(slice);
                    }
                    onupdate(++stepsTaken, stepsTotal, "contour x");
                    dec();
                });
            }
        }

        if (!concurrent) resolver();

        await promise;

        // const lines = newslices.map(s => (s.camLines || []).map(p => p.length));
        // const points = lines.flat().reduce((a,b) => a+b);
        // console.log({ lines, points });

        trace.cleanup();
    }

}

export class Probe {

    constructor(params) {

        const { data, profile } = params;
        const { stepsX, stepsY, boundsX, zMin, minX, minY } = params;

        this.params = params;

        // return the touching z given topo x,y and a tool profile
        const toolAtZ = this.toolAtZ = function (x, y) {
            let sx = stepsX,
                sy = stepsY,
                xl = sx - 1,
                yl = sy - 1;

            let gv, i = 0, mz = -Infinity;

            while (i < profile.length) {
                // tool profile point x, y, and z offsets
                const tx = profile[i++] + x;
                const ty = profile[i++] + y;
                const tz = profile[i++];
                if (tx < 0 || tx > xl || ty < 0 || ty > yl) {
                    // if outside max topo steps, use zMin
                    gv = zMin;
                } else {
                    // lookup grid value @ tx, ty
                    gv = data[tx * sy + ty] || zMin;
                }
                // update the rest
                mz = Math.max(tz + gv, mz);
            }

            return Math.max(mz, zMin);
        }

        // fractional probe for radial tracing: rays walk fractional world
        // positions which map to fractional heightmap grid coordinates.
        // chosen approach: bilinear interpolation of the 4 surrounding
        // grid nodes, applied per tool-profile sample before the max()
        // convolution (vs. snapping each sample to the nearest integer
        // node, which staircases the heightmap on diagonal rays)
        const toolAtZf = this.toolAtZf = function (x, y) {
            let sx = stepsX,
                sy = stepsY,
                xl = sx - 1,
                yl = sy - 1;

            let gv, i = 0, mz = -Infinity;

            while (i < profile.length) {
                // tool profile point x, y, and z offsets
                const tx = profile[i++] + x;
                const ty = profile[i++] + y;
                const tz = profile[i++];
                if (tx < 0 || tx > xl || ty < 0 || ty > yl) {
                    // if outside max topo steps, use zMin
                    gv = zMin;
                } else {
                    // bilinear over the 4 surrounding grid nodes
                    const x0 = Math.floor(tx),
                        y0 = Math.floor(ty),
                        x1 = Math.min(x0 + 1, xl),
                        y1 = Math.min(y0 + 1, yl),
                        fx = tx - x0,
                        fy = ty - y0,
                        v00 = data[x0 * sy + y0] || zMin,
                        v10 = data[x1 * sy + y0] || zMin,
                        v01 = data[x0 * sy + y1] || zMin,
                        v11 = data[x1 * sy + y1] || zMin;
                    gv = (v00 * (1 - fx) + v10 * fx) * (1 - fy)
                       + (v01 * (1 - fx) + v11 * fx) * fy;
                }
                // update the rest
                mz = Math.max(tz + gv, mz);
            }

            return Math.max(mz, zMin);
        }

        // export z probe function
        const rx = stepsX / boundsX;
        const ry = stepsX / boundsX;
        const toolAtXY = this.toolAtXY = function (px, py) {
            px = Math.round(rx * (px - minX));
            py = Math.round(ry * (py - minY));
            return toolAtZ(px, py);
        };

        const zAtXY = this.zAtXY = function (px, py) {
            let ix = Math.round(rx * (px - minX));
            let iy = Math.round(ry * (py - minY));
            return data[ix * stepsY + iy] || zMin;
        };
    }

}

export class Trace {

    constructor(probe, params) {

        const { curvesOnly, maxangle, flatness, bridge, contourX, merged, leave } = params;

        this.params = params;
        this.probe = probe;

        let trace,
            slice,
            latent,
            lastPP,
            lastSlope;

        const newslice = this.newslice = () => {
            this.slice = slice = [];
        }

        const newtrace = this.newtrace = function () {
            trace = newPolygon().setOpen();
        }

        const end_poly = this.end_poly = function (point) {
            if (latent) {
                trace.push(latent);
            }
            if (trace.length > 0) {
                // add additional constraint on min perimeter()
                if (trace.length > 1) {
                    slice.push(trace);
                }
                newtrace();
            }
            lastPP = undefined;
            latent = undefined;
            lastSlope = undefined;
            if (point) {
                trace.push(point);
                lastPP = point;
            }
        }

        const log = function (map) {
            for (let key in map) {
                const val = map[key];
                if (typeof val === 'number') {
                    map[key] = val.round(4);
                }
            }
            console.log(...arguments);
        }

        this.push_point = function (x, y, z) {
            const newP = newPoint(x, y, z);
            const lastP = lastPP;

            // merged contours blend two raster directions, so their profile
            // carries kinks from both. decimate with a tighter slope threshold
            // so gentle curvature is not over-smoothed into stair artifacts
            const sflat = merged ? flatness / 4 : flatness;

            if (lastP) {
                // euclidean planar step length. the legacy expression
                // `(dx || dy)` assumed axis-aligned steps and mis-computed
                // the slope on diagonal radial rays. for axis-aligned paths
                // one delta is always exactly 0, so hypot is identical.
                const dl = Math.hypot(x - lastP.x, y - lastP.y);
                const dz = z - lastP.z;
                const slope = Math.atan2(dz, dl);
                if (curvesOnly && Math.abs(dz) < flatness) {
                    end_poly(newP);
                } else if (lastSlope !== undefined && Math.abs(lastSlope - slope) < sflat) {
                    latent = newP;
                } else {
                    if (latent) {
                        trace.push(latent);
                        latent = undefined;
                    }
                    if (curvesOnly) {
                        const dv = contourX ? Math.abs(lastP.x - x) : Math.abs(lastP.y - y);
                        const angle = Math.atan2(Math.abs(dz), dv) * RAD2DEG;
                        if (angle > maxangle) {
                            end_poly();
                        }
                    }
                    trace.push(newP);
                }
                lastSlope = slope;
            } else {
                trace.push(newP);
            }

            lastPP = newP;
        }

        const object = this.object = this;

        this.inClip = function (clips, checkZ, point) {
            let ok = 0;
            for (let i = 0; i < clips.length; i++) {
                let poly = clips[i];
                let zok = checkZ ? checkZ <= poly.z : true;
                object.tabZ = poly.z;
                if (zok && point.isInPolygon(poly)) {
                    ok++;
                }
            }
            return ok > 0;
        }

    }

    init(params) {
        this.cross = params;
        const { minions } = self.kiri_worker ?? {};
        const { clipTab, clipTabZ } = params;

        // because codec does not encode arbitrary fields
        // in this case, z is appended to clip tabs in topo constructor
        // we pass it as a side-channel and re-consitute here
        if (clipTab)
            for (let i = 0, l = clipTab.length; i < l; i++) {
                clipTab[i].z = clipTabZ[i];
            }

        if (minions && this.cross.concurrent) {
            minions.broadcast("trace_init", codec.encode({
                probe: this.probe.params,
                trace: this.params,
                cross: params,
            }));
        }
    }

    cleanup() {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.broadcast("trace_cleanup");
        }
    }

    crossY(params, then) {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.queue({
                cmd: "trace_y",
                params
            }, data => {
                then(codec.decode(data.slice));
            });
        } else {
            this.crossY_sync(params, then);
        }
    }

    crossX(params, then) {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.queue({
                cmd: "trace_x",
                params
            }, data => {
                then(codec.decode(data.slice));
            });
        } else {
            this.crossX_sync(params, then);
        }
    }

    crossY_sync(params, then) {
        const { push_point, end_poly, newtrace, newslice, inClip } = this.object;
        const { clipTab, tabHeight, clipTo, box, resolution, density, leave } = this.cross;
        const { toolAtZ } = this.probe;

        let { from, to, x, gridx, gridy } = params;

        const step = resolution * density;
        const checkr = newPoint(0, 0);
        newslice();
        newtrace();
        for (let y = from; y < to; y += step) {
            if (y < box.min.y || y > box.max.y) {
                gridy += density;
                continue;
            }
            // find tool z at grid point
            let tv = toolAtZ(gridx, gridy);
            checkr.x = x;
            checkr.y = y;
            // when tabs are on and this point is inside the
            // tab polygon, ensure z is at least tabHeight
            if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                tv = this.tabZ;
            }
            // if the value is on the floor and inside the clip
            // poly (usually shadow), end the segment
            if (clipTo && !inClip(clipTo, undefined, checkr)) {
                end_poly();
                gridy += density;
                continue;
            }
            push_point(x, y, tv + leave);
            gridy += density;
        }
        end_poly();
        then(this.slice);
    }

    crossX_sync(params, then) {
        const { push_point, end_poly, newtrace, newslice, inClip } = this.object;
        const { clipTab, tabHeight, clipTo, box, resolution, density, leave } = this.cross;
        const { toolAtZ } = this.probe;
        let { from, to, y, gridx, gridy } = params;

        const step = resolution * density;
        const checkr = newPoint(0, 0);
        newslice();
        newtrace();
        for (let x = from; x < to; x += step) {
            if (x < box.min.x || x > box.max.x) {
                gridx += density;
                continue;
            }
            // find tool z at grid point
            let tv = toolAtZ(gridx, gridy);
            checkr.x = x;
            checkr.y = y;
            // when tabs are on and this point is inside the
            // tab polygon, ensure z is at least tabHeight
            if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                tv = this.tabZ;
            }
            // if the value is on the floor and inside the clip
            // poly (usually shadow), end the segment
            if (clipTo && !inClip(clipTo, undefined, checkr)) {
                end_poly();
                gridx += density;
                continue;
            }
            push_point(x, y, tv + leave);
            gridx += density;
        }
        end_poly();
        then(this.slice);
    }

    crossM(params, then) {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.queue({
                cmd: "trace_m",
                params
            }, data => {
                then(codec.decode(data.slice));
            });
        } else {
            this.crossM_sync(params, then);
        }
    }

    // merged contouring: trace one family of the X+Y raster pair. dir "y"
    // traces a Y-direction column, dir "x" an X-direction row. at each
    // point, z is the lower of what the point's own raster family reaches
    // there and what the orthogonal family reaches (its nearest path,
    // linearly interpolated along that path to this point). running both
    // families this way removes the union of material the two sequential
    // single-axis passes would remove.
    crossM_sync(params, then) {
        const { push_point, end_poly, newtrace, newslice, inClip } = this.object;
        const { clipTab, tabHeight, clipTo, box, resolution, density, leave } = this.cross;
        const { minX, minY, boundsX, boundsY, stepsX, stepsY, toolStep } = this.cross;
        const { toolAtZ } = this.probe;

        let { dir, from, to, x, y, gridx, gridy, altT, altA, altB } = params;

        // memoize probes: every path crossing a grid point re-probes it
        const cache = this.mcache = this.mcache || new Map();
        const probeM = (gx, gy) => {
            const key = gx + ":" + gy;
            let v = cache.get(key);
            if (v === undefined) {
                cache.set(key, v = toolAtZ(gx, gy));
            }
            return v;
        };

        const step = resolution * density;
        const checkr = newPoint(0, 0);
        newslice();
        newtrace();

        if (dir === "x") {
            // X-direction row: own raster samples sit on exact x grid
            // vertices; orthogonal Y-columns sit at toolStep x positions,
            // sampled at grid y indices altA/altB bracketing this row
            // (fraction altT), matching crossY_sync stepping
            for (let px = from; px < to; px += step) {
                if (px < box.min.x || px > box.max.x) {
                    gridx += density;
                    continue;
                }
                // z reached by the X-axis raster at this row point
                let tv = toolAtZ(gridx, gridy);
                // z reached by the Y-axis raster: nearest column to this
                // point, interpolated along the column to this row's y
                const cx = from + Math.round((px - from) / toolStep) * toolStep;
                if (cx >= box.min.x && cx <= box.max.x) {
                    const gridxC = Math.round(((cx - minX) / boundsX) * stepsX);
                    const za = probeM(gridxC, altA);
                    const zb = probeM(gridxC, altB);
                    const tvC = za + (zb - za) * altT;
                    if (tvC < tv) {
                        tv = tvC;
                    }
                }
                checkr.x = px;
                checkr.y = y;
                // when tabs are on and this point is inside the
                // tab polygon, ensure z is at least tabHeight
                if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                    tv = this.tabZ;
                }
                // if the value is on the floor and inside the clip
                // poly (usually shadow), end the segment
                if (clipTo && !inClip(clipTo, undefined, checkr)) {
                    end_poly();
                    gridx += density;
                    continue;
                }
                push_point(px, y, tv + leave);
                gridx += density;
            }
        } else {
            // Y-direction column: own raster samples at the snapped column
            // grid x; orthogonal X-rows sit at toolStep y positions, sampled
            // at grid x vertices altA/altB bracketing this column (fraction
            // altT), matching crossX_sync stepping
            for (let py = from; py < to; py += step) {
                if (py < box.min.y || py > box.max.y) {
                    gridy += density;
                    continue;
                }
                // z reached by the Y-axis raster at this column point
                let tv = toolAtZ(gridx, gridy);
                // z reached by the X-axis raster: nearest row to this point,
                // interpolated along the row to this column's x position
                const ry = from + Math.round((py - from) / toolStep) * toolStep;
                if (ry >= box.min.y && ry <= box.max.y) {
                    const gridyR = Math.round(((ry - minY) / boundsY) * stepsY);
                    const za = probeM(altA, gridyR);
                    const zb = probeM(altB, gridyR);
                    const tvR = za + (zb - za) * altT;
                    if (tvR < tv) {
                        tv = tvR;
                    }
                }
                checkr.x = x;
                checkr.y = py;
                // when tabs are on and this point is inside the
                // tab polygon, ensure z is at least tabHeight
                if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                    tv = this.tabZ;
                }
                // if the value is on the floor and inside the clip
                // poly (usually shadow), end the segment
                if (clipTo && !inClip(clipTo, undefined, checkr)) {
                    end_poly();
                    gridy += density;
                    continue;
                }
                push_point(x, py, tv + leave);
                gridy += density;
            }
        }
        end_poly();
        then(this.slice);
    }

    crossR(params, then) {
        const { minions } = self.kiri_worker;

        if (minions && this.cross.concurrent) {
            minions.queue({
                cmd: "trace_r",
                params
            }, data => {
                then(codec.decode(data.slice));
            });
        } else {
            this.crossR_sync(params, then);
        }
    }

    // radial contouring: trace one vertical secant ray of the fan. params
    // carry the fan center (cx,cy = stock center), the ray's unit direction
    // (cos/sin of its angle) and the radial span [from,to]. unlike
    // crossX/Y_sync which step on exact integer grid vertices, rays walk
    // fractional world positions, so the fractional probe toolAtZf (bilinear
    // over the heightmap) is used. per-point tab clamping, clip-to segment
    // breaking and point pushing mirror crossX/Y_sync verbatim.
    crossR_sync(params, then) {
        const { push_point, end_poly, newtrace, newslice, inClip } = this.object;
        const { clipTab, tabHeight, clipTo, box, resolution, density, leave } = this.cross;
        const { minX, minY } = this.cross;
        const { toolAtZf } = this.probe;

        let { cx, cy, cos, sin, from, to } = params;

        const step = resolution * density;
        const checkr = newPoint(0, 0);
        newslice();
        newtrace();
        for (let r = from; r < to; r += step) {
            const x = cx + r * cos;
            const y = cy + r * sin;
            if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y) {
                continue;
            }
            // tool z at this world position via fractional heightmap coords.
            // the raster writes node (gx,gy) at world (minX + gx*resolution,
            // minY + gy*resolution), so the exact world->grid map divides by
            // resolution (the legacy bounds/steps formula carries a half-cell
            // bias that Math.round callers tolerate; fractional rays do not)
            let tv = toolAtZf(
                (x - minX) / resolution,
                (y - minY) / resolution
            );
            checkr.x = x;
            checkr.y = y;
            // when tabs are on and this point is inside the
            // tab polygon, ensure z is at least tabHeight
            if (clipTab && clipTab.length && tv < tabHeight && inClip(clipTab, tv, checkr)) {
                tv = this.tabZ;
            }
            // if the value is on the floor and inside the clip
            // poly (usually shadow), end the segment
            if (clipTo && !inClip(clipTo, undefined, checkr)) {
                end_poly();
                continue;
            }
            push_point(x, y, tv + leave);
        }
        end_poly();
        then(this.slice);
    }
}

export function raster_slice(inputs) {
    const { lines, data, box, resolution, curvesOnly } = inputs;
    const { flatness, zMin, minY, maxY, stepsY, gridx } = inputs;
    const { slice } = inputs;

    let gridy,
        gridi, // index
        gridv, // value
        i, il, j, x, y, tv;

    // filter lines pairs to only surface "up-facing", "uncovered" lines
    let points = [];
    // emit an array of valid line-pairs
    const len = lines.length;

    outer: for (let i = 0; i < len; i++) {
        let l1 = lines[i], p1 = l1.p1, p2 = l1.p2;
        // eliminate vertical
        if (Math.abs(p1.y - p2.y) < flatness) continue;
        // eliminate if both points below cutoff
        if (p1.z < zMin && p2.z < zMin) continue;
        // sort p1,p2 by y for comparison
        if (p1.y > p2.y) { const tp = p1; p1 = p2; p2 = tp };
        // eliminate if points "under" other lines
        for (let j = 0; j < len; j++) {
            // skip self and adjacent
            if (j >= i - 1 && j <= i + 1) continue;
            let l2 = lines[j], p3 = l2.p1, p4 = l2.p2;
            // sort p3,p4 by y for comparison
            if (p3.y > p4.y) { const tp = p3; p3 = p4; p4 = tp };
            // it's under the other line
            if (Math.max(p1.z, p2.z) < Math.min(p3.z, p4.z)) {
                // it's inside the other line, too, so skip
                if (p1.y >= p3.y && p2.y <= p4.y) continue outer;
            }
        }
        points.push(p1, p2);
        box.expandByPoint(p1);
        box.expandByPoint(p2);
    }

    gridy = 0;
    // rasterize one x slice
    for (y = minY; y < maxY && gridy < stepsY; y += resolution) {
        gridi = gridx * stepsY + gridy;
        gridv = data[gridi] || zMin;
        // strategy using raw lines (faster slice, but more lines)
        for (i = 0, il = points.length; i < il; i += 2) {
            const p1 = points[i], p2 = points[i + 1];
            // one endpoint above grid
            const crossz = (p1.z > gridv || p2.z > gridv);
            // segment crosses grid y
            const spansy = (p1.y <= y && p2.y >= y);
            if (crossz && spansy) {
                // compute intersection of z ray up
                // and segment at this grid point
                const dy = p1.y - p2.y,
                    dz = p1.z - p2.z,
                    pct = (p1.y - y) / dy,
                    nz = p1.z - (dz * pct);
                // save if point is greater than existing grid point
                if (nz > gridv) {
                    gridv = data[gridi] = Math.max(nz, zMin);
                    if (slice) slice.output()
                        .setLayer("heights", { face: 0, line: 0 })
                        .addLine(
                            newPoint(p1.x, y, 0),
                            newPoint(p1.x, y, gridv)
                        );
                }
            }
        }
        gridy++;
    }

    // remove flat lines when curvesOnly
    if (curvesOnly) {
        let nup = [];
        for (let i = 0, p = points, l = p.length; i < l; i += 2) {
            const p1 = p[i];
            const p2 = p[i + 1];
            if (Math.abs(p1.z - p2.z) >= flatness) {
                nup.push(p1, p2);
            }
        }
        points = nup;
    }

    return points;
};

export async function generate(opt) {
    return new Topo().generate(opt);
}
