/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

// todo: surface offset pattern
// todo: trace dogbones, merge overlap

import { CamOp } from '../core/op.js';
import { Tool } from '../core/tool.js';
import { newSlice } from '../../../core/slice.js';
import { newPoint } from '../../../../geo/point.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { polygons as POLY } from '../../../../geo/polygons.js';
import { util as base_util } from '../../../../geo/base.js';
import { tip2tipJoin } from '../../../../geo/paths.js';
import { CAM } from './init-work.js';

const DEG2RAD = Math.PI / 180;
const clib = self.ClipperLib;
const ctyp = clib.ClipType;
const ptyp = clib.PolyType;
const cfil = clib.PolyFillType;
const ts_eps = 0.01;

class OpArea extends CamOp {
    constructor(state, op) {
        super(state, op);
    }

    async slice(progress) {
        let { op, state } = this;
        let { direction, down, expand, flats, flatOff, follow } = op;
        let { mode, outline, over, rename, smooth, tool } = op;
        let { addSlices, axisIndex, color, cutTabs, settings } = state;
        let { shadowAt, setToolDiam, tabs, widget, workarea } = state;

        let areaTool = new Tool(settings, tool);
        let smoothVal = (smooth ?? 0) / 10;
        let toolDiam = areaTool.fluteDiameter();
        let toolOver = this.toolOver = areaTool.getStepSize(over);
        let zTop = workarea.top_z;
        let zBottom = workarea.bottom_z;
        let shadowBase = state.shadow.base;
        let thruHoles = state.shadow.holes;
        let roundSharps = settings.process.camRoundCorners;

        // get these once and re-use for each area
        let vertices = mode === 'surface' ?
            widget.getGeoVertices({ unroll: true, translate: true }) :
            undefined;

        // also updates tab offsets
        setToolDiam(toolDiam);

        // selected area polygons: surfaces and edges
        let { devel, edgeangle } = settings.controller;
        let polys = [];
        let stack = [];
        let surfaces = this.surfaces = [];
        let areas = this.areas = [ stack ];
        let aminz = Infinity;

        function newArea() {
            if (stack.length) {
                stack = [];
                areas.push(stack);
            }
        }

        function newLayer(z) {
            stack.push(newSlice(z));
            return stack.peek();
        }

        // gather area selections
        if (!op.shadow)
        for (let arr of (op.areas[widget.id] ?? [])) {
            let poly = newPolygon().fromArray(arr);
            aminz = Math.min(aminz, poly.minZ());
            polys.push(poly);
            // user-selected traces are not rotated
            // those based on shadow (outline, rough) are
            if (!op.rotated && axisIndex) {
                // traces come from unrotatead widget edges
                poly.applyRotations(axisIndex);
            }
        }

        // connect open poly edge segments into closed loops (when possible)
        // surface and edge selections produce open polygons by default
        polys = POLY.nest(POLY.reconnect(polys, false));

        // gather surface selections
        if (!op.shadow) {
            let vert = widget.getGeoVertices({ unroll: true, translate: true }).map(v => v.round(4));
            let faces = CAM.surface_find(widget, (op.surfaces[widget.id] ?? []), (follow ?? edgeangle ?? 5) * DEG2RAD);
            let fpoly = [];
            for (let face of faces) {
                let i = face * 9;
                fpoly.push(newPolygon()
                    .add(vert[i++], vert[i++], aminz = Math.min(aminz, vert[i++]))
                    .add(vert[i++], vert[i++], aminz = Math.min(aminz, vert[i++]))
                    .add(vert[i++], vert[i++], aminz = Math.min(aminz, vert[i++]))
                );
            }
            // remove invalid edges (eg. when vertical walls are the only selection)
            fpoly = fpoly.filter(p => p.area() > 0.001);

            // add in unioned surface areas
            polys.push(...POLY.setZ(POLY.union(fpoly, 0.00001, true), aminz));
        }

        // use part shadow instead of areas or surfaces
        if (op.shadow) {
            polys.push(...shadowBase.clone(true));
        }

        // smoothing for jaggies usually caused by vertical walls
        if (smoothVal) {
            polys = polys.map(poly => POLY.offset(POLY.offset([ poly ], smoothVal), -smoothVal)).flat();
            POLY.setZ(polys, aminz);
        }

        // expand selections (flattens z variable polys)
        if (Math.abs(expand) > 0) {
            let nupolys = polys.filter(p => p.open); // set aside open
            for (let p of polys.filter(p => !p.open)) {
                let expanded = POLY.expand([ p ], expand);
                if (expanded) {
                    POLY.setZ(expanded, p.minZ());
                    nupolys.push(...expanded.flat());
                }
            }
            // polys = nupolys;
            // re-merge after expansion in case it produces overlap
            polys = POLY.union(nupolys, 0.00001, true);
        }

        // filter out invalid polys
        polys = polys.filter(p => p && p.length > 2);

        // process each area separately
        let proc = 0;
        let pinc = 1 / polys.length;
        for (let area of polys) {
            let bounds = area.getBounds3D();
            let ts_off = toolDiam / 2 + (op.leave_xy ?? 0) + ts_eps;
            let offopt = {
                arc: 250,
                join: roundSharps ? ClipperLib.JoinType.jtRound : undefined,
                clean: true,
                simple: false,
                cleanDist: 10,
                minArea: 0.01,
            };

            if (outline) {
                // remove inner voids when processing outline only
                area.inner = undefined;
            }

            newLayer().output()
                .setLayer("area", { line: 0xff8800 }, false)
                .addPolys([ area ]);

            newArea();

            if (mode === 'clear') {
                let zMov = flatOff ?? 0;
                let zs = flats ?
                    flats.filter(z => z <= zTop && z >= zBottom).map(v => v + zMov) :
                    down ? base_util.lerp(zTop, zBottom, down) : [ bounds.min.z ];
                let zroc = 0;
                let zinc = 1 / zs.length;
                let lzo;

                if (!zs.length) break;

                outer: for (;;)
                for (let z of zs) {
                    let slice = newLayer(z);
                    let layers = slice.output();
                    let shadow = await shadowAt(z + 0.01);
                    let tool_shadow = [
                        ...POLY.offset(shadow, [  ts_off ], { count: 1, z, ...offopt }),
                        ...POLY.offset(shadow, [ -ts_off ], { count: 1, z, ...offopt }),
                    ];
                    // for roughing/outline backward compatability
                    if (op.omitthru) {
                        shadow = omitMatching(shadow, thruHoles);
                    }
                    // progressive offset of polygons inside area clipped to the shadow
                    let outs = [];
                    let clip = [];
                    let firstOff = -(toolDiam / 2 + (op.leave_xy ?? 0));
                    // remove shadow from area
                    if (op.ignore) {
                        clip = [ area ];
                    } else {
                        POLY.subtract([ area ], shadow, clip, undefined, undefined, 0);
                    }
                    // remove regions already cleared by a prior roughing pass
                    // (rough "flats" mode) so we don't raster through air
                    if (op.flat_mask) {
                        let cleared = op.flat_mask[z] ?? [];
                        if (cleared.length) {
                            let reduced = [];
                            POLY.subtract(clip, cleared, reduced, undefined, undefined, 0);
                            clip = reduced;
                        }
                        if (!clip.length) {
                            // plane fully cleared by roughing: skip to the next
                            zroc += zinc;
                            lzo = z;
                            progress(proc + (pinc * zroc), 'clear');
                            if (z === zs.peek()) break outer;
                            continue;
                        }
                    }
                    //generate offsets to use
                    let offsets = [ firstOff ];
                    //if we need a finish cut, add it
                    let finish_cut = op.finish_cut ?? 0;
                    if (finish_cut != 0) { //todo: this should check for camInnerFirst and warn if it is not true
                        offsets.push(-finish_cut);
                    }
                    //everything else uses the tool stepover
                    offsets.push(-toolOver);
                    // when enabled, stitch the offset rings into a single
                    // continuous morphing spiral instead of emitting them
                    // as discrete closed rings. this removes the radial
                    // ring-to-ring transition moves (two ~90 degree turns
                    // each) that make machines stop and shed inertia.
                    // falls back to the discrete rings below when the
                    // geometry does not support a spiral for this area
                    let doSpiral = op.spiral && !op.walls && !op.omitouter && !tabs.length;
                    if (doSpiral) {
                        // collect rings per offset depth via the collector.
                        // the offset accumulator is a throwaway: rings must
                        // not leak into the output when the stitch succeeds
                        let rings = [];
                        POLY.offset(clip, offsets, {
                            count: op.steps ?? 999, outs: [], flat: true, z: z - zMov, ...offopt,
                            call: (polys, count, depth) => { rings[depth] = polys; }
                        });
                        // on success the spiral (and optional finish ring)
                        // are appended to `outs`; on failure the discrete
                        // rings are emitted as-is, matching legacy output
                        if (!stitchSpiral(rings, {
                            outs,
                            finish: op.spiral_finish,
                            spacing: toolOver / 2
                        })) {
                            for (let level of rings) {
                                if (level) outs.push(...level);
                            }
                        }
                    } else {
                        //actually offset the walls inwards
                        POLY.offset(clip, offsets, {
                            count: op.walls ? 1 : (op.steps ?? 999), outs, flat: true, z: z - zMov, ...offopt
                        });
                    }
                    // if we see no offsets, re-check the mesh bottom Z then exit
                    if (outs.length === 0) {
                        if (op.flat_mask) {
                            // flats pass: nothing left to cut at this plane,
                            // move on to the next instead of terminating
                            zroc += zinc;
                            lzo = z;
                            progress(proc + (pinc * zroc), 'clear');
                            if (z === zs.peek()) break outer;
                            continue;
                        }
                        if (bounds && lzo > bounds.min.z) {
                            // try a bottom layer matching bottom of selection
                            zs = [ bounds.min.z ];
                            bounds = undefined;
                            continue outer;
                        }
                        // terminate z descent when no further output possible
                        break outer;
                    }
                    // support legacy outline features
                    if (op.omitouter) {
                        outs = omitOuter(outs);
                    } else if (op.omitinner) {
                        outs = omitInner(outs);
                    }
                    // cut tabs when present
                    if (tabs.length) outs = cutTabs(tabs, outs);
                    // for roughing backward compatability
                    if (op.leave_z) {
                        for (let out of outs)
                            for (let p of out.points)
                                p.z += op.leave_z;
                    }
                    // add tabs to travel boundaries
                    if (tabs.length) {
                        let tab_shadows = tabs.filter(t => t.top >= z).map(t => t.poly);
                        if (tab_shadows) tool_shadow.push(...tab_shadows);
                    }
                    POLY.setWinding(outs, direction === 'climb');
                    // store travel boundary that triggers up and over moves
                    slice.tool_shadow = [ area, ...shadow, ...tool_shadow ];
                    slice.camLines = outs;
                    zroc += zinc;
                    lzo = z;
                    progress(proc + (pinc * zroc), 'clear');
                    if (devel) layers
                        .setLayer("base", { line: 0xff0000 }, false)
                        .addPolys(shadowBase)
                        .setLayer("shadow", { line: 0x00ff00 }, false)
                        .addPolys(shadow)
                        .setLayer("tool shadow", { line: 0x44ff88 }, false)
                        .addPolys(tool_shadow);
                    layers
                        .setLayer(rename ?? "clear", { line: color }, false)
                        .addPolys(outs);
                    // of the last output still cuts, we need an escape
                    if (z === zs.peek()) {
                        break outer;
                    }
                }
                proc += pinc;
                progress(proc, 'clear');
            } else
            if (mode === 'trace') {
                let { tr_over, tr_offz, tr_type  } = op;
                let zs = down ? base_util.lerp(zTop, op.thru ? zBottom : Math.max(zBottom, area.minZ()), down) : [ bounds.min.z ];
                let zroc = 0;
                let zinc = 1 / zs.length;
                if (tr_offz) zs = zs.map(z => z - tr_offz);
                for (let z of zs) {
                    let slice = newLayer(z);
                    let layers = slice.output();
                    let shadow = op.base ? state.shadow.base : await shadowAt(z);
                    let outs = [];
                    if (tr_type === 'none') {
                        // todo: move this out of the zs loop and only setZ when needed
                        area = area.clone(true);
                        outs = [ zs.length > 1 || op.thru ? area.setZ(z) : clampZ(area, zTop, zBottom) ];
                    } else {
                        // drape is legacy outline
                        let offit = op.drape ? shadow : [ area ];
                        if (op.omitthru && op.drape) {
                            offit = omitMatching(offit, thruHoles);
                        }
                        // todo: move this out of the zs loop
                        let stepping = tr_type === 'inside' ?
                            ( tr_over ? -tr_over : [ -toolDiam / 2, -toolOver ] ) :
                            ( tr_over ? tr_over : [ toolDiam / 2, toolOver ] );
                        POLY.offset(offit, stepping, {
                            count: op.steps ?? 1, outs, flat: true, z, minArea: 0, open: true
                        });
                    }
                    if (outs.length === 0 && !op.drape) {
                        // terminate z descent when no further output possible
                        break;
                    }
                    // add dogbones when specified
                    if (op.dogbones) outs.forEach(out => out.addDogbones(toolDiam / 5, op.revbones));
                    // support legacy outline features
                    if (op.omitouter) {
                        outs = omitOuter(outs);
                    } else if (op.omitinner) {
                        outs = omitInner(outs);
                    }
                    // cut tabs when present
                    if (tabs.length) outs = cutTabs(tabs, outs);
                    slice.camLines = outs;
                    POLY.setWinding(outs, direction === 'climb');
                    // store travel boundary that triggers up and over moves
                    let tool_shadow = slice.tool_shadow = shadow.clone(true);
                    if (area.isOpen()) {
                        tool_shadow.push(...outs[0].clone().setZ(z).offset_open(toolDiam / 2, 'round'));
                    } else {
                        tool_shadow.push(
                            area,
                            ...POLY.offset(shadow, [  ts_off ], { count: 1, z, ...offopt }),
                            ...POLY.offset(shadow, [ -ts_off ], { count: 1, z, ...offopt }),
                        );
                    }
                    // add tabs to travel boundaries
                    if (tabs) {
                        let tab_shadows = tabs.filter(t => t.top >= z).map(t => t.poly);
                        if (tab_shadows) slice.tool_shadow.push(...tab_shadows);
                    }
                    zroc += zinc;
                    progress(proc + (pinc * zroc), 'trace');
                    if (devel) layers
                        .setLayer("base", { line: 0xff0000 }, false)
                        .addPolys(shadowBase)
                        .setLayer("shadow", { line: 0x00ff00 }, false)
                        .addPolys(shadow)
                        .setLayer("tool shadow", { line: 0x44ff88 }, false)
                        .addPolys(tool_shadow);
                    layers
                        .setLayer(rename ?? "trace", { line: color }, false)
                        .addPolys(outs);
                }
                proc += pinc;
                progress(proc, 'trace');
                // legacy outline early termination b/c use of
                // shadow will cause duplicate output with area
                if (tr_type === 'outside' && op.drape) {
                    break;
                }
            } else
            if (mode === 'surface') {
                let { sr_type, sr_angle, sr_alter, tolerance } = op;

                let resolution = tolerance || 0.05;
                let raster = await self.get_raster_gpu({ mode: "tracing", resolution });
                let surface = [];
                let paths = [];

                // prepare paths
                if (sr_type === 'linear') {
                    // scan the area bounding box with rays at defined angle
                    let scan = scanBoxAtAngle(bounds, sr_angle * DEG2RAD, toolOver);
                    let lines = scan.map(line => {
                        let { a, b } = line;
                        return [ newPoint(a.x, a.y, 0).toClipper(), newPoint(b.x, b.y, 0).toClipper() ]
                    });
                    // use clipper to clip lines to the area polygon
                    let clip = new clib.Clipper();
                    let ctre = new clib.PolyTree();
                    clip.AddPaths(lines, ptyp.ptSubject, false);
                    clip.AddPaths(POLY.toClipper([ area ]), ptyp.ptClip, true);
                    if (clip.Execute(ctyp.ctIntersection, ctre, cfil.pftNonZero, cfil.pftEvenOdd)) {
                        for (let node of ctre.m_AllPolys) {
                            paths.push(POLY.fromClipperNode(node, 0));
                        }
                    }
                    // in surfacing mode, direction is simply reversal
                    if (direction === 'climb') {
                        paths.forEach(path => path.reverse());
                    }
                    // optional alternating paths
                    if (paths.length && sr_alter) {
                        paths = tip2tipJoin(paths, paths[0].first(), toolOver * 10);
                    }
                } else
                if (sr_type === 'offset') {
                    // progressive inset from perimeter
                    POLY.offset([ area ], [ -toolDiam / 2, -toolOver ], {
                        count: 999, outs: paths, flat: true, z: 0, minArea: 0
                    });
                    paths.forEach(poly => poly.isClosed() && poly.push(poly.first()));
                    POLY.setWinding(paths.filter(p => p.isClosed()), direction === 'climb');
                } else
                if (sr_type === 'spiral') {
                    // continuous archimedean spiral centered on the area bounds
                    // r = pitch * theta / (2*pi) with pitch = stepover
                    let cx = (bounds.min.x + bounds.max.x) / 2;
                    let cy = (bounds.min.y + bounds.max.y) / 2;
                    // cover the full bounding diagonal so outer revolutions
                    // reach every corner of the area before clipping
                    let maxr = Math.hypot(
                        bounds.max.x - bounds.min.x,
                        bounds.max.y - bounds.min.y
                    ) / 2 + toolOver;
                    let pitch = toolOver;
                    let b = pitch / (2 * Math.PI);
                    // densify so arc length between points stays under stepover/2
                    let seg = toolOver / 2;
                    let spiral = [];
                    let theta = 0;
                    for (;;) {
                        let r = b * theta;
                        if (r > maxr) break;
                        spiral.push(newPoint(
                            cx + r * Math.cos(theta),
                            cy + r * Math.sin(theta), 0
                        ).toClipper());
                        // ds/dtheta = b * sqrt(theta^2 + 1) for archimedean spiral
                        theta += seg / (b * Math.hypot(theta, 1));
                    }
                    // use clipper to clip spiral (open path) to the area polygon
                    let clip = new clib.Clipper();
                    let ctre = new clib.PolyTree();
                    clip.AddPaths([ spiral ], ptyp.ptSubject, false);
                    clip.AddPaths(POLY.toClipper([ area ]), ptyp.ptClip, true);
                    if (clip.Execute(ctyp.ctIntersection, ctre, cfil.pftNonZero, cfil.pftEvenOdd)) {
                        for (let node of ctre.m_AllPolys) {
                            paths.push(POLY.fromClipperNode(node, 0));
                        }
                    }
                }

                // convert resulting poly lines to raster float32 array groups
                paths = paths.map(poly => poly.points.map(p => [ p.x, p.y ]).flat().toFloat32());

                // prepare tool mesh points
                let toolBounds = new THREE.Box3()
                    .expandByPoint({ x: -toolDiam/2, y: -toolDiam/2, z: 0 })
                    .expandByPoint({ x: toolDiam/2, y: toolDiam/2, z: 0 });
                let toolPos = areaTool.generateProfile(resolution).profile.slice();
                for (let i=0; i<toolPos.length; i+= 3) {
                    toolBounds.expandByPoint({ x: toolPos[i], y: toolPos[i+1], z: toolPos[i+2] });
                }
                let toolData = { positions: toolPos, bounds: toolBounds };

                // prepare terrain and raster paths over terrain
                let wbounds = bounds.clone().expandByVector({ x: toolDiam/2, y: toolDiam/2, z: 0 });
                wbounds.min.z = zBottom;
                wbounds.max.z = zTop;
                await raster.loadTool({
                    sparseData: toolData
                });
                await raster.loadTerrain({
                    triangles: vertices,
                    boundsOverride: wbounds
                });
                if (paths.length === 0) {
                    // skip raster if no output generated
                    continue;
                }
                let output = await raster.generateToolpaths({
                    paths,
                    step: toolOver / 2,
                    zFloor: zBottom,
                    onProgress: pct => progress(proc + (pinc * (pct/100)))
                });
                raster.terminate();

                // convert terrain raster output back to open polylines
                // todo: add leave_z support
                for (let path of output.paths) {
                    // split terrain-following output at the operation's z
                    // bottom, dropping segments that dip below it instead of
                    // clamping them flat onto the z bottom plane
                    let parts = dropBelowZ(newPolygon().fromArray([1, ...path]), zBottom);
                    for (let part of parts) {
                        if (op.refine) part.refine(op.refine);
                        surface.push(part);
                        let slice = newLayer();
                        slice.camLines = [ part ];
                        slice.output()
                            .setLayer(rename ?? "linear", { line: color }, false)
                            .addPolys([ part ]);
                    }
                }

                // output this surface
                surfaces.push(surface);

                proc += pinc;
                progress(proc);
            }
        }
        // filter out empty slices
        this.areas = areas = areas.map(area => {
            return area.filter(slice => slice.camLines && slice.camLines.length);
        }).filter(a => a.length);

        // only render slices containing ares to mill
        addSlices(areas.flat().filter(s => s.camLines && s.camLines.length));
    }

    prepare(ops, progress) {
        let { op, state, areas, surfaces, toolOver } = this;
        let { newLayer, pocket, polyEmit, printPoint, tip2tipEmit } = ops;
        let { setContouring, setNextIsMove } = ops;
        let { process } = state.settings;

        // process surface paths
        if (surfaces.length) {
            setContouring(true, toolOver * 2);
            for (let surface of surfaces) {
                for (let poly of surface) {
                    setNextIsMove();
                    printPoint = polyEmit(poly);
                    newLayer();
                }
            }
            setContouring(false);
            // skip areas when processing surfaces
            return;
        }

        // process areas as pockets
        while (areas?.length) {
            let min = {
                dist: Infinity,
                area: undefined,
                point: undefined
            };

            for (let area of areas.filter(p => !p.used)) {
                // skip devel / debug only areas
                let topPolys = area[0].camLines;
                if (!topPolys) continue;
                // select poly with largest area
                let poly = topPolys.slice().sort((a,b) => b.area() - a.area())[0];
                if (!poly) continue;
                // compute move distance to top poly for efficient routing
                let find = poly.findClosestPointTo(printPoint);
                if (find.distance < min.dist) {
                    min.area = area;
                    min.dist = find.distance;
                    min.point = find.point
                }
            }

            // if we have a next-closest top poly, pocket that
            if (min.area) {
                min.area.used = true;
                printPoint = min.point;
                pocket({
                    cutdir: op.ov_conv,
                    depthFirst: process.camDepthFirst,
                    easeDown: op.down && process.easeDown ? op.down : 0,
                    outline: op.drape || op.mode === 'trace',
                    progress: (n,m) => progress(n/m, "area"),
                    slices: min.area.filter(slice => slice.camLines)
                });
            } else {
                break;
            }
        }
    }
}

/**
 * Resample a closed polygon into `n` points evenly spaced along its
 * perimeter. The point sequence starts at the polygon point closest to
 * `start` so that consecutive concentric rings (which are roughly
 * parallel) line up index-for-index at corresponding angular positions.
 *
 * @param {Polygon} poly closed source polygon
 * @param {number} n number of output points
 * @param {Point} start alignment reference point
 * @returns {Point[]} n resampled points
 */
function resampleRing(poly, n, start) {
    let pts = poly.points;
    let len = pts.length;
    // rotate the point list to begin at the point nearest `start`
    let best = 0, bd = Infinity;
    for (let i = 0; i < len; i++) {
        let d = pts[i].distTo2D(start);
        if (d < bd) {
            bd = d;
            best = i;
        }
    }
    let rot = [];
    for (let i = 0; i < len; i++) {
        rot.push(pts[(best + i) % len]);
    }
    // cumulative arc lengths over the closed ring
    let cum = [ 0 ];
    for (let i = 0; i < len; i++) {
        cum.push(cum[i] + rot[i].distTo2D(rot[(i + 1) % len]));
    }
    let total = cum[len];
    let out = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
        let target = (total * k) / n;
        while (seg < len - 1 && cum[seg + 1] < target) seg++;
        let a = rot[seg];
        let b = rot[(seg + 1) % len];
        let seglen = (cum[seg + 1] - cum[seg]) || 1e-9;
        let t = (target - cum[seg]) / seglen;
        out.push(newPoint(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t
        ));
    }
    return out;
}

/**
 * Stitch consecutive concentric offset rings into a single continuous
 * open "morphing spiral" polyline.
 *
 * The first revolution lies exactly on the outermost ring (a full pass
 * along the wall allowance contour before any inward offset begins).
 * Each subsequent revolution starts on the previous ring and smoothly
 * morphs onto the next ring over the final `blend` fraction of the
 * revolution (smoothstep easing), so ring-to-ring transitions become a
 * continuous radial ramp with no discrete radial moves or ~90 degree
 * direction reversals. A final full revolution on the innermost ring
 * clears the center, and an optional full closed ring along the wall
 * allowance contour can be appended for wall finishing.
 *
 * For non-circular pockets (rectangles, arbitrary shapes) corners are
 * softened by the morph but not eliminated — an accepted trade-off of
 * this strategy.
 *
 * The clip area may consist of several disjoint regions (eg. roughing a
 * boss with a central bore: the stock visible through the bore is a
 * clip island next to the region hugging the part). Regions are seeded
 * from the polygons of the shallowest non-empty level and every deeper
 * polygon is assigned to the region whose material contains it (inset
 * polygons always nest inside their originating region). Each region is
 * stitched independently into its own spiral.
 *
 * Within a region, a level that fragments into multiple disjoint
 * polygons (or grows a second hole) ends that region's monotone
 * progression rather than failing the stitch: the "good" prefix of
 * levels is spiraled and the polygons of the fragmented level (and all
 * deeper levels) are appended after the region's spiral as discrete
 * cutting loops. This is the common roughing case where stock corners
 * outlive a receding annulus. A region with fewer than two loops (eg. a
 * bore island eroded away by the first offset) emits its rings
 * discretely. The stitch is skipped entirely (returns false, `outs`
 * untouched) only when no region produces a spiral, or for structurally
 * degenerate ring sets: open or degenerate rings anywhere. The caller
 * then falls back to the discrete ring output.
 *
 * Rings may carry a single hole (`.inner`), which is how offset levels
 * of an annulus look — roughing clears the region between the area
 * boundary and the part shadow, so every level yields the receding outer
 * boundary plus the contour hugging the part. Both are cutting loops on
 * that depth. Sorted by size, the combined loops of all levels form one
 * monotone progression from the outer boundary inward to the part wall:
 * the spiral starts with a full revolution on the outermost loop, morphs
 * through the intermediate contours and ends with a full revolution
 * around the part wall, where the optional finish ring is appended.
 *
 * @param {Polygon[][]} rings one entry per offset depth (outermost/wall
 *   ring first), each holding the polygons generated at that depth
 * @param {Object} opts
 * @param {Polygon[]} opts.outs output collector for generated polys
 * @param {number} opts.spacing resample spacing (stepover / 2)
 * @param {boolean} [opts.finish] append a full closed finish ring along
 *   the wall allowance contour (default true)
 * @param {number} [opts.blend] fraction of a revolution over which the
 *   morph to the next ring happens (default 0.25)
 * @returns {boolean} true when a spiral was generated
 */
function stitchSpiral(rings, opts) {
    const outs = opts.outs;
    const spacing = opts.spacing > 0 ? opts.spacing : 0.1;
    const blend = opts.blend ?? 0.25;
    const finish = opts.finish !== false;

    // require at least two rings (a single ring gains nothing from
    // stitching)
    if (!rings || rings.length < 2) {
        return false;
    }
    // open or degenerate loops anywhere are a structural failure:
    // fall back to the legacy discrete emission for the whole set
    for (let level of rings) {
        if (!level) continue;
        for (let poly of level) {
            if (poly.open || poly.length < 4) {
                return false;
            }
            if (poly.inner) {
                for (let inner of poly.inner) {
                    if (inner.open || inner.length < 4 || inner.inner) {
                        return false;
                    }
                }
            }
        }
    }

    // split the ring set into independent region progressions. the
    // polygons of the shallowest non-empty level seed one region each;
    // deeper polygons are assigned to the region whose material (outer
    // minus holes) contains them, which always holds for inset offsets
    let seedIdx = rings.findIndex(level => level && level.length);
    if (seedIdx < 0) {
        return false;
    }
    let seeds = rings[seedIdx];
    let regions = seeds.map(() => []);
    for (let i = seedIdx; i < rings.length; i++) {
        let level = rings[i];
        for (let r = 0; r < regions.length; r++) {
            regions[r].push([]);
        }
        if (!level || !level.length) {
            continue;
        }
        for (let poly of level) {
            let region = seeds.findIndex(seed => poly.first().isInPolygon(seed));
            if (region < 0) {
                // unclassifiable geometry: full legacy fallback
                return false;
            }
            regions[region][i - seedIdx].push(poly);
        }
    }

    // stitch each region's progression; regions that cannot produce a
    // spiral (too few loops, degenerate geometry) emit their rings
    // discretely
    let result = [];
    let spiraled = false;
    for (let region of regions) {
        let stitched = stitchRegion(region, { spacing, blend });
        if (stitched) {
            spiraled = true;
            result.push(stitched.spiral);
            if (finish) {
                result.push((stitched.wall ?? stitched.loop).clone(true).setClosed());
            }
            if (stitched.remainder.length) {
                result.push(...stitched.remainder);
            }
        } else {
            for (let level of region) {
                if (level && level.length) {
                    result.push(...level);
                }
            }
        }
    }
    if (!spiraled) {
        return false;
    }
    outs.push(...result);
    return true;
}

/**
 * Stitch one region's monotone progression of offset levels into a
 * single morphing spiral. See stitchSpiral() for a description of the
 * generated path. Returns null when the region yields fewer than two
 * loops or a degenerate spiral, in which case the caller emits the
 * region's levels as discrete cutting loops.
 *
 * @param {Polygon[][]} levels per-offset-depth polygons of one region
 * @param {Object} opts
 * @param {number} opts.spacing resample spacing (stepover / 2)
 * @param {number} opts.blend fraction of a revolution used to morph
 * @returns {{ spiral: Polygon, wall: Polygon, loop: Polygon,
 *            remainder: Polygon[] } | null}
 */
function stitchRegion(levels, opts) {
    const spacing = opts.spacing;
    const blend = opts.blend;

    // collect the cutting loops of every offset depth: a level without
    // holes contributes its single outer loop (pocket style); a level
    // with exactly one hole contributes that hole's contour as well
    // (annulus / roughing style). a fragmented level (multiple polygons,
    // e.g. stock corners outliving a receding annulus) or a level with
    // more than one hole ends the monotone progression: the loops
    // collected so far are spiraled and the fragmented level plus all
    // deeper levels are appended discretely after the spiral
    let loops = [];
    let wall = null;
    let remainder = [];
    let split = false;
    for (let level of levels) {
        if (!level || !level.length) {
            // no geometry at this depth: the progression (if any) ends
            // here; deeper levels, if any, clear discretely
            split = true;
            continue;
        }
        if (split) {
            remainder.push(...level);
            continue;
        }
        if (level.length !== 1) {
            split = true;
            remainder.push(...level);
            continue;
        }
        let poly = level[0];
        if (poly.inner && poly.inner.length !== 1) {
            // multiple islands pinched off inside the contour: treat
            // like a fragmented level
            split = true;
            remainder.push(...level);
            continue;
        }
        if (poly.inner) {
            let inner = poly.inner[0];
            // the first (shallowest) level's hole hugs the part wall
            if (!wall) {
                wall = inner;
            }
            loops.push(poly, inner);
        } else {
            loops.push(poly);
        }
    }
    // a single loop gains nothing from stitching
    if (loops.length < 2) {
        return null;
    }
    if (wall) {
        // annulus levels interleave receding outer and growing inner
        // contours; order the combined loops largest-first so revolutions
        // progress monotonically from the outer boundary to the part
        // wall. pocket-style loops are already in this order.
        loops.sort((a, b) => Math.abs(b.area()) - Math.abs(a.area()));
    }
    // the spiral must traverse every loop in the same rotational
    // direction, so flip any loop running opposite to the first.
    // clones keep the original rings intact for the caller's fallback
    for (let i = 1; i < loops.length; i++) {
        if (loops[i].isClockwise() !== loops[0].isClockwise()) {
            loops[i] = loops[i].clone(true).reverse();
        }
    }

    // resample every ring to a common point count, each starting at the
    // point closest to the previous ring's start so index i tracks the
    // same angular position on every ring
    let n = 16;
    for (let loop of loops) {
        n = Math.max(n, Math.ceil(loop.perimeter() / spacing));
    }
    n = Math.min(n, 4096);
    let res = [];
    let start = loops[0].first();
    for (let loop of loops) {
        let r = resampleRing(loop, n, start);
        res.push(r);
        start = r[0];
    }

    let spiral = newPolygon().setOpen();
    let push = (a, b, w) => {
        let p = newPoint(
            a.x + (b.x - a.x) * w,
            a.y + (b.y - a.y) * w,
            a.z + (b.z - a.z) * w
        );
        // drop near-duplicate points from degenerate blends
        let last = spiral.last();
        if (!last || last.distTo2D(p) > 0.001) {
            spiral.push(p);
        }
    };
    let last = loops.length - 1;
    // revolution 0: full pass along the outermost (wall) ring
    for (let p of res[0]) {
        push(p, p, 0);
    }
    // revolutions 1..last: ride ring i-1, morph onto ring i over the
    // final `blend` fraction of the revolution
    for (let i = 1; i <= last; i++) {
        let prev = res[i - 1];
        let cur = res[i];
        for (let k = 0; k < n; k++) {
            let u = k / n;
            let w = u <= (1 - blend) ? 0 : (u - (1 - blend)) / blend;
            w = w * w * (3 - 2 * w); // smoothstep
            push(prev[k], cur[k], w);
        }
    }
    // final full revolution on the innermost ring clears the center
    for (let p of res[last]) {
        push(p, p, 0);
    }

    if (spiral.length < 4) {
        return null;
    }

    return { spiral, wall, loop: loops[0], remainder };
}

function omitOuter(polys) {
    let inner = [];
    for (let poly of polys) {
        if (poly.inner) inner.push(...poly.inner);
    }
    return inner;
}

function omitInner(polys) {
    for (let poly of polys) {
        poly.inner = undefined;
    }
    return polys;
}

function omitMatching(target, matches) {
    target = target.clone(true);
    for (let poly of target.filter(p => p.inner)) {
        poly.inner = poly.inner.filter(inner => {
            for (let ho of matches) {
                if (inner.isEquivalent(ho)) {
                    return false;
                }
            }
            return true;
        });
    }
    return target;
}

/**
 * Split an open polyline where it crosses below a z plane. Segments at or
 * above `zmin` are kept, with interpolated points inserted where the path
 * crosses the plane. Portions strictly below `zmin` are dropped. Returns
 * an array of open polylines (possibly empty).
 */
function dropBelowZ(poly, zmin) {
    let outs = [];
    let points = poly.points;
    let cur = null;
    let add = (p) => {
        if (!cur) {
            cur = newPolygon().setOpen();
            outs.push(cur);
        }
        cur.push(p);
    };
    // interpolate the point where a segment crosses the zmin plane
    let cross = (q, p) => {
        let t = (zmin - q.z) / (p.z - q.z);
        return newPoint(
            q.x + t * (p.x - q.x),
            q.y + t * (p.y - q.y),
            zmin
        );
    };
    for (let i = 0; i < points.length; i++) {
        let p = points[i];
        if (p.z >= zmin) {
            // entering the kept region from below: start at the crossing
            if (cur === null && i > 0) {
                let q = points[i - 1];
                if (q.z < zmin && p.z > zmin) {
                    add(cross(q, p));
                }
            }
            add(p);
        } else if (cur !== null) {
            // leaving the kept region: end at the crossing
            let q = points[i - 1];
            if (q.z > zmin) {
                cur.push(cross(q, p));
            }
            cur = null;
        }
    }
    // discard degenerate single-point fragments (touch-and-dip)
    return outs.filter(p => p.length > 1);
}

function clampZ(poly, max, min) {
    for (let p of poly.points) {
        if (p.z < min) p.z = min;
        else if (p.z > max) p.z = max;
    }
    if (poly.inner) {
        for (let p of poly.inner) {
            clampZ(p, max, min);
        }
    }
    return poly;
}

// box2: THREE.Box2
// angle: radians (direction of each scan ray)
// step: spacing between parallel rays (world units)
function scanBoxAtAngle(box2, angle, step) {
    const cx = (box2.min.x + box2.max.x) * 0.5;
    const cy = (box2.min.y + box2.max.y) * 0.5;
    const w = box2.max.x - box2.min.x;
    const h = box2.max.y - box2.min.y;

    // ray direction
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    // normal between rays (perpendicular to ray dir)
    const nx = -dy;
    const ny = dx;

    // extent of the box along the normal
    const extentN = Math.abs(nx) * w + Math.abs(ny) * h;

    // length of each ray across the box (along ray dir)
    const extentD = Math.abs(dx) * w + Math.abs(dy) * h;

    // how many rays to cover the box; +1 so edges are covered
    const count = Math.max(1, Math.ceil(extentN / step) + 1);

    const halfSpan = step * (count - 1) * 0.5;
    const halfD = extentD * 0.5;
    const rays = [];

    for (let i = 0; i < count; i++) {
        // offset along normal
        const o = -halfSpan + i * step;
        const ox = cx + nx * o;
        const oy = cy + ny * o;

        // segment endpoints for this ray inside (or slightly outside) the box
        const ax = ox - dx * halfD;
        const ay = oy - dy * halfD;
        const bx = ox + dx * halfD;
        const by = oy + dy * halfD;

        rays.push({
            a: new THREE.Vector2(ax, ay),
            b: new THREE.Vector2(bx, by),
        });
    }

    return rays;
}

export { OpArea, omitMatching };
