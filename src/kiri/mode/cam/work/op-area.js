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
// round-join arc tolerance (mm) for internal-only tool-disk sweeps (travel
// boundaries, engagement/coverage tests). these are never emitted as cut
// paths, so a coarse tolerance costs nothing visible; the clipper default
// (~2.5e-6 mm) generates ~2500 arc segments per circle, which makes each
// sweep over a long polyline take seconds
const sweepArc = 0.01;

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
                // anchor for the next spiral's start: the end of the most
                // recently stitched spiral (previous depth, or previous
                // region within the same depth). the tool enters the next
                // spiral from that point, so starting the spiral there —
                // instead of at a fixed point on the outermost ring —
                // eliminates the cross-pocket traversal between depths
                // (resampleRing aligns the outermost ring's start to it,
                // and the emitter's greedy ordering then picks the spiral
                // first). unknown for the first spiral, which falls back
                // to the ring's own first point
                let spiralRef;

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
                    let clip = [];
                    // full clip before skipclear reduction, and the cleared
                    // region subtracted from it: kept so the flats fallback
                    // below can re-raster the full clip and trim pure air
                    let clipFull = null;
                    let cleared = null;
                    let firstOff = -(toolDiam / 2 + (op.leave_xy ?? 0));
                    // remove shadow from area
                    if (op.ignore) {
                        clip = [ area ];
                    } else {
                        POLY.subtract([ area ], shadow, clip, undefined, undefined, 0);
                    }
                    // remove regions prior operations already cleared down to
                    // (or below) this layer's cut plane, per the stock removal
                    // model (StockModel.clearedRegion, work/stock.js). this
                    // generalizes the intra-op rough-clear masking to the
                    // inter-op level: rough → pocket → rough sequences don't
                    // re-mill air over material a previous op removed. the
                    // region only counts as cleared when remaining material
                    // sits at or below this op's raised tip (cut plane +
                    // leave_z), so leave stock is respected. missing or
                    // invalid model (rotary work) falls through untouched
                    // effective tip plane for stock-model queries. z includes
                    // flatOff for flats passes (v + zMov above); the tip plane
                    // paths actually cut at is z - zMov, so the "already
                    // cleared" threshold must be raised from the real tip, not
                    // the flatOff-shifted value. flats omit leave_z: their job
                    // is to shave the leave_z skin off flat planes, so
                    // "cleared" means remaining material at or below the bare
                    // cut plane. at a plane level with the stock top, lower
                    // the threshold strictly below it: virgin cells (never
                    // touched by roughing, heightmap == stock top) must not
                    // count as cleared, or facing the raw stock top would be
                    // skipped. shared by skipclear masking below and the
                    // void-anchored ring regeneration further down
                    let f = z - zMov;
                    let tipz = flats ?
                        (f >= zTop - ts_eps ? f - ts_eps : f) :
                        f + (op.leave_z ?? 0);
                    if (op.skipclear && state.stockModel?.valid) {
                        cleared = state.stockModel.clearedRegion(clip, tipz);
                        if (cleared.length) {
                            clipFull = clip;
                            let reduced = [];
                            POLY.subtract(clip, cleared, reduced, undefined, undefined, 0);
                            clip = reduced;
                        }
                    }
                    if (!clip.length && (flats || op.skipclear)) {
                        // plane fully cleared by roughing or prior passes:
                        // skip to the next
                        zroc += zinc;
                        lzo = z;
                        progress(proc + (pinc * zroc), 'clear');
                        if (z === zs.peek()) break outer;
                        continue;
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
                    // tabs do not disable the spiral: they are a local z
                    // lift applied after the fact via cutTabs() below,
                    // which splits the open spiral polyline over each tab
                    // zone just like it splits the discrete rings
                    // falls back to the discrete rings below when the
                    // geometry does not support a spiral for this area
                    let doSpiral = op.spiral && !op.walls && !op.omitouter;
                    // generate the clearing paths (discrete offset rings or a
                    // stitched spiral) for a clip region. factored out so the
                    // flats air-trim fallback below can re-run it on the full
                    // (un-cleared) clip when the reduced clip yields nothing
                    let genOuts = (gclip) => {
                        let gouts = [];
                        let gspiral = false;
                        if (doSpiral) {
                            // collect rings per offset depth via the collector.
                            // the offset accumulator is a throwaway: rings must
                            // not leak into the output when the stitch succeeds
                            let rings = [];
                            POLY.offset(gclip, offsets, {
                                count: op.steps ?? 999, outs: [], flat: true, z: z - zMov, ...offopt,
                                call: (polys, count, depth) => { rings[depth] = polys; }
                            });
                            // on success the spiral (and optional finish ring)
                            // are appended to `outs` and its end point becomes
                            // the start anchor for the next depth's spiral;
                            // on failure the discrete rings are emitted as-is,
                            // matching legacy output
                            let stitched = stitchSpiral(rings, {
                                outs: gouts,
                                finish: op.spiral_finish,
                                spacing: toolOver / 2,
                                start: spiralRef
                            });
                            if (!stitched) {
                                for (let level of rings) {
                                    if (level) gouts.push(...level);
                                }
                            } else {
                                gspiral = true;
                                spiralRef = stitched.end;
                            }
                        } else {
                            //actually offset the walls inwards
                            POLY.offset(gclip, offsets, {
                                count: op.walls ? 1 : (op.steps ?? 999), outs: gouts, flat: true, z: z - zMov, ...offopt
                            });
                        }
                        return { outs: gouts, spiral: gspiral };
                    };
                    // true when this depth produced at least one stitched
                    // spiral: its open fragments get flagged below so the
                    // emitter can apply a helical ease-down along the
                    // spiral's leading revolution
                    let { outs, spiral: didSpiral } = genOuts(clip);
                    // void-anchored ring regeneration (free-edge first
                    // machining). the classic wall-anchored progression
                    // above anchors ring 1 at the occupied boundary
                    // (firstOff = -(R + leave)) and steps inward: when the
                    // stock removal model verifies that material adjacent
                    // to the clip was already removed down to this plane
                    // (a ledge/shelf bordering a roughed cavity, a pocket
                    // re-cleaned after roughing), that progression wastes
                    // passes — ring 1 cuts the full remaining width in one
                    // full-engagement pass and later rings ride over
                    // verified void. when the model is present and valid,
                    // replace the ring set with one anchored on the
                    // free-edge boundary: ring 1 sits max(R - S, 0) beyond
                    // the free edge (over model-verified air, or on the
                    // edge itself when S >= R), rings advance
                    // by the stepover S toward the occupied wall, and the
                    // wall-anchored ring(s) are appended last as a light
                    // finishing pass. when the free edge borders a model
                    // cavity (verified against the matrix), the anchor is
                    // the smooth model contour of that cavity wall — no
                    // pixel wiggle; otherwise the pixel (heightmap strip)
                    // anchoring applies unchanged. falls through to the
                    // legacy rings above when the model is missing/invalid
                    // (rotary work), in spiral mode, or when the
                    // regenerated set would leave material uncovered
                    // (see freeAnchorRings). stepover >= 50% is allowed:
                    // with S >= R the first family ring sits on the free
                    // edge (max 50% radial immersion) instead of hanging
                    // over the void, still removing ~min(S, R) of fresh
                    // material — which is what rescues wide stepovers on
                    // narrow ledges where the legacy firstOff ring
                    // collapses (see #703ee573)
                    if (!didSpiral && !op.ignore && !op.walls &&
                        state.stockModel?.valid
                    ) {
                        // async: may slice the mesh just below the cut
                        // plane for model-true free-edge contours (cached
                        // per z by the widget)
                        let alt = await freeAnchorRings({
                            stockModel: state.stockModel,
                            clip,
                            clipBase: clipFull ?? clip,
                            shadow,
                            tipz,
                            cutz: z - zMov,
                            z: z - zMov,
                            R: toolDiam / 2,
                            L: op.leave_xy ?? 0,
                            S: toolOver,
                            firstOff,
                            finishCut: finish_cut,
                            offopt,
                            steps: op.steps ?? 999,
                            shadowAt
                        });
                        if (alt) outs = alt;
                    }
                    // if we see no offsets, re-check the mesh bottom Z then exit
                    if (outs.length === 0) {
                        if (flats && cleared && clipFull) {
                            // flats fallback: material left on this plane (a
                            // thin ledge/ring between an already-cleared cavity
                            // and the surrounding walls) can be too narrow for
                            // the tool to fit inside, so offsetting the reduced
                            // clip yields nothing. re-generate the raster over
                            // the full (un-cleared) clip — paths then cross the
                            // cleared air — and trim the segments passing over
                            // pure air: the full clip minus the remaining
                            // material dilated by the tool radius marks where
                            // the tool disk touches no material at all.
                            // segments over (or within a radius of) material
                            // survive, which is what lets the tool reach and
                            // shave a narrow ledge
                            let gen = genOuts(clipFull);
                            if (gen.outs.length) {
                                // trim mask is built from the material side,
                                // not the air side. `cleared` comes back from
                                // clearedRegion as one-cell-tall strip rects
                                // which POLY.offset erodes to nothing (each
                                // thin rect collapses individually), so the
                                // air-trim would become a no-op. instead
                                // dilate the remaining material (the reduced
                                // clip) by the tool radius (+ ts_eps to cover
                                // heightmap grid quantization): the dilation
                                // marks where the tool disk still touches
                                // material. dilating cannot collapse thin
                                // regions, so the mask below is always sound
                                let useful = POLY.offset(clip, [ toolDiam / 2 + ts_eps ], { z: z - zMov, ...offopt });
                                let mask = [];
                                if (useful.length) {
                                    POLY.subtract(clipFull, useful, mask, undefined, undefined, 0);
                                } else {
                                    // dilation failed: nothing is reachable,
                                    // the entire full raster is pure air
                                    mask = clipFull;
                                }
                                let trimmed = [];
                                for (let out of gen.outs) {
                                    let cutp = mask.length ? out.cut(mask) : null;
                                    if (cutp) trimmed.push(...cutp);
                                    else trimmed.push(out);
                                }
                                if (trimmed.length) {
                                    outs = trimmed;
                                    didSpiral = gen.spiral;
                                }
                            }
                        }
                        if (outs.length === 0) {
                            if (flats) {
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
                    }
                    // support legacy outline features
                    if (op.omitouter) {
                        outs = omitOuter(outs);
                    } else if (op.omitinner) {
                        outs = omitInner(outs);
                    }
                    // cut tabs when present
                    if (tabs.length) outs = cutTabs(tabs, outs);
                    // flag open spiral fragments for the emitter's helical
                    // ease-down (revolution 0 doubles as the ramp to depth).
                    // done after cutTabs because it rebuilds polylines and
                    // would drop a marker set at stitch time; discrete rings,
                    // finish rings and remainder loops are all closed and
                    // thus never flagged
                    if (didSpiral) {
                        for (let out of outs) {
                            if (out.open) out.spiral = true;
                        }
                    }
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
                        tool_shadow.push(...outs[0].clone().setZ(z).offset_open(toolDiam / 2, 'round', 2, sweepArc));
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

        // clear one-shot "used" markers consumed by the area selection
        // loop below, so repeated prepare (eg. a cached slice restore that
        // skips re-slicing) regenerates the full toolpath instead of
        // finding every area already used and emitting travel-only output
        for (let area of areas ?? []) {
            area.used = false;
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
 * morphs onto the next ring (smoothstep easing) — the first transition
 * spans the ENTIRE revolution so the outermost ring is not re-traced
 * after its full pass, later transitions morph over the final `blend`
 * fraction of the revolution — so ring-to-ring transitions become a
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
 * around the part wall, where the optional finish ring is appended —
 * unless that ring duplicates a full revolution the spiral already
 * cuts exactly (see stitchRegion()), in which case it is omitted.
 *
 * @param {Polygon[][]} rings one entry per offset depth (outermost/wall
 *   ring first), each holding the polygons generated at that depth
 * @param {Object} opts
 * @param {Polygon[]} opts.outs output collector for generated polys
 * @param {number} opts.spacing resample spacing (stepover / 2)
 * @param {boolean} [opts.finish] append a full closed finish ring along
 *   the wall allowance contour, skipped when it duplicates an exact
 *   revolution of the spiral (default true)
 * @param {number} [opts.blend] fraction of a revolution over which the
 *   morph to the next ring happens (default 0.25)
 * @param {number} [opts.first_blend] fraction of revolution 1 used to
 *   morph ring 0 -> ring 1; 1 spans the entire revolution so the
 *   outermost ring is cut exactly once before spiraling inward
 *   (default 1)
 * @param {Point} [opts.start] anchor point the (first region's) spiral
 *   should begin near — typically the end point of the previously
 *   stitched spiral, so consecutive spirals start where the tool
 *   already is instead of at a fixed point on the outermost ring.
 *   each subsequent region's spiral is anchored to the previous
 *   region's end point (default: outermost ring's first point)
 * @returns {{ end: Point } | false} the end point of the last stitched
 *   spiral (next anchor) when a spiral was generated, false otherwise
 *   (`outs` untouched in that case)
 */
function stitchSpiral(rings, opts) {
    const outs = opts.outs;
    const spacing = opts.spacing > 0 ? opts.spacing : 0.1;
    const blend = opts.blend ?? 0.25;
    const first_blend = opts.first_blend ?? 1;
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
    // discretely. regions are stitched in seed (slice) order and each
    // region's spiral start is anchored to the previous region's end
    // point, so consecutive spirals (within a level and across depths)
    // begin near where the tool already is
    let result = [];
    let spiraled = false;
    let ref = opts.start;
    for (let region of regions) {
        let stitched = stitchRegion(region, { spacing, blend, first_blend, start: ref });
        if (stitched) {
            spiraled = true;
            result.push(stitched.spiral);
            // skip the finish ring when it duplicates a full revolution
            // the spiral already cuts exactly: for pocket-style regions
            // (no wall) it is loops[0], identical to revolution 0; for
            // annulus regions it is the wall contour, identical to the
            // final revolution when the wall is the innermost loop.
            // when the helical plunge along revolution 0 lands (task
            // #5c71df7e), revolution 0 stops being a full-depth pass and
            // the pocket-style finish ring must be reinstated
            if (finish && !stitched.finish_dup) {
                let ring = (stitched.wall ?? stitched.loop).clone(true).setClosed();
                // flag for the emitter: the ring engages the material
                // around the full tool circumference (camFullEngage feed
                // scale) only when the emitter outputs it before any
                // spiral at its depth — the first cut into fresh material
                // there. when it follows the spiral (the anchored order
                // fde3050d produces) it runs at full feed. cutTabs() below
                // may rebuild the polyline, so the marker is carried
                // through it
                ring.finish_ring = true;
                result.push(ring);
            }
            if (stitched.remainder.length) {
                result.push(...stitched.remainder);
            }
            // the spiral ends on the innermost ring; any appended finish
            // ring starts (at output time) at the wall point nearest this
            // end, so the spiral end remains the best available anchor
            // for the next spiral
            ref = stitched.end;
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
    // authored-order stamp (see stampFarrSeq): the spiral precedes its
    // finish ring and any remainder loops; without the stamp the greedy
    // emitter can output the finish ring ahead of the spiral (which then
    // relies on the polyEmit engage-detection workaround instead of the
    // authored order)
    outs.push(...stampFarrSeq(result));
    return { end: ref };
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
 * @param {number} [opts.first_blend] fraction of revolution 1 used to
 *   morph ring 0 -> ring 1 (default 1 = whole revolution)
 * @param {Point} [opts.start] anchor point the spiral should begin near
 *   (see stitchSpiral()); defaults to the outermost ring's first point
 * @returns {{ spiral: Polygon, wall: Polygon, loop: Polygon,
 *            remainder: Polygon[], finish_dup: boolean, end: Point } | null}
 *   `end` is the spiral's last point (the next spiral's start anchor);
 *   `finish_dup` is true when the caller's finish ring candidate
 *   (`wall`, or `loop` for pocket-style regions) coincides with a full
 *   revolution the spiral already cuts exactly: revolution 0 for
 *   pocket-style regions (ring == loops[0]), or the final revolution
 *   for annulus regions whose wall is the innermost loop. only the
 *   first and last rings receive exact full revolutions; intermediate
 *   rings are visited via blending only, so a wall there is not a
 *   duplicate and the finish ring remains necessary
 */
function stitchRegion(levels, opts) {
    const spacing = opts.spacing;
    const blend = opts.blend;
    const firstBlend = opts.first_blend ?? 1;

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
    // the wall terminates the sorted progression when it is the innermost
    // (smallest) loop, in which case the final revolution cuts it exactly
    // and an appended finish ring would traverse it a second time. checked
    // before the direction normalization below, which may replace loops
    // with reversed clones and break reference equality
    let wallIsLast = wall && loops[loops.length - 1] === wall;
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
    // same angular position on every ring. the initial reference comes
    // from opts.start (the anchor point the spiral should begin near,
    // e.g. where the tool ended the previous depth) and falls back to
    // the first point of the outermost ring
    let n = 16;
    for (let loop of loops) {
        n = Math.max(n, Math.ceil(loop.perimeter() / spacing));
    }
    n = Math.min(n, 4096);
    let res = [];
    let start = opts.start ?? loops[0].first();
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
    // flag revolution 0 points for the emitter: the camFullEngage feed
    // ramp applies only to this first full-engagement pass along the
    // outermost ring — later revolutions are offset cuts in partially
    // cleared material and run at full feed (task #cfca80a4). flags
    // live on the point objects so they survive polygon clones and
    // winding reversals downstream
    for (let p of spiral.points) {
        p.rev0 = true;
    }
    // revolutions 1..last: ride ring i-1, morph onto ring i. the first
    // transition (ring 0 -> ring 1) morphs across the ENTIRE revolution
    // (`firstBlend`): revolution 0 already gives the outermost ring its
    // full pass, so riding it for another (1 - blend) fraction before
    // any inward motion would only re-trace an already-cut contour.
    // later transitions keep the configured blend so each intermediate
    // ring still receives most of a full cutting revolution.
    for (let i = 1; i <= last; i++) {
        let prev = res[i - 1];
        let cur = res[i];
        let bl = i === 1 ? firstBlend : blend;
        for (let k = 0; k < n; k++) {
            let u = k / n;
            let w = u <= (1 - bl) ? 0 : (u - (1 - bl)) / bl;
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

    return {
        spiral,
        wall,
        loop: loops[0],
        remainder,
        finish_dup: wall ? wallIsLast : true,
        // the spiral's last point: the caller chains it as the start
        // anchor for the next depth's / region's spiral
        end: spiral.last()
    };
}

/**
 * Douglas-Peucker polyline simplification with collinear-point merge.
 *
 * Used to de-staircase the stock model's heightmap-derived void boundary:
 * the morphological close in smoothPixelVoid removes most of the grid
 * staircase but leaves a residue of ~0.25 * resolution amplitude, which
 * every offset ring of the family inherits (and amplifies, since each
 * ring is an offset of the previous boundary). DP with a sub-cell
 * tolerance collapses the residue into long smooth segments, which also
 * shrinks vertex counts for the subsequent Clipper offsets. The merged
 * boundary may extend the void by at most `tol` (chords cut corners on
 * either side) — acceptable, since engagement and coverage are computed
 * from the same smoothed contours, keeping them consistent.
 *
 * `closed` treats the point list as a ring (the first point is not
 * repeated at the end). The ring is split at its farthest-from-anchor
 * point into two open chains so the DP anchors are guaranteed stable
 * vertices; a final pass merges points that are collinear with their
 * kept neighbors (the split anchors may sit mid-segment on a long
 * straight run). Endpoints of open paths are always preserved.
 *
 * @param {Point[]} points polygon points (x/y used, z untouched)
 * @param {number} tol max deviation in mm
 * @param {boolean} closed true for rings, false for open paths
 * @returns {Point[]} simplified point list (new array, input untouched)
 */
function simplifyPoints(points, tol, closed) {
    const n = points.length;
    const min = closed ? 3 : 2;
    if (n <= min) {
        return points.slice();
    }
    const tolSq = tol * tol;
    // squared distance of p from segment a-b (clamped projection, so a
    // point "past" an endpoint measures to the endpoint, not the line)
    const segDistSq = (p, a, b) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-16) {
            return p.distToSq2D(a);
        }
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a.x + t * dx - p.x, py = a.y + t * dy - p.y;
        return px * px + py * py;
    };
    // mark points kept by DP over the half-open index chain [i..j] of
    // `chain` (an index list into `points`); iterative, not recursive —
    // long chains would blow the call stack in the worst case
    const dpMark = (chain, from, to, keep) => {
        const stack = [ from, to ];
        while (stack.length) {
            const j = stack.pop(), i = stack.pop();
            let dmax = -1, imax = -1;
            for (let m = i + 1; m < j; m++) {
                const idx = chain[m];
                const d = segDistSq(points[idx], points[chain[i]], points[chain[j]]);
                if (d > dmax) {
                    dmax = d;
                    imax = m;
                }
            }
            if (imax > 0 && dmax > tolSq) {
                keep[chain[imax]] = true;
                stack.push(i, imax, imax, j);
            }
        }
    };
    const keep = new Array(n).fill(false);
    if (closed) {
        // split the ring at the point farthest from point 0
        let k = 1, dmax = -1;
        for (let i = 1; i < n; i++) {
            const d = points[i].distToSq2D(points[0]);
            if (d > dmax) {
                dmax = d;
                k = i;
            }
        }
        if (dmax <= tolSq) {
            // entire ring collapses toward a point: keep it untouched
            // (degenerate tiny contour, DP cannot improve on it)
            return points.slice();
        }
        // chain A: indices 0..k, chain B: indices k..n-1 then wrap to 0
        keep[0] = keep[k] = true;
        dpMark(points.map((_, i) => i), 0, k, keep);
        const chainB = [];
        for (let i = k; i < n; i++) {
            chainB.push(i);
        }
        chainB.push(0);
        dpMark(chainB, 0, chainB.length - 1, keep);
    } else {
        keep[0] = keep[n - 1] = true;
        dpMark(points.map((_, i) => i), 0, n - 1, keep);
    }
    // collinear merge: drop kept points lying (within 1 um) on the line
    // between their nearest kept neighbors. DP already removed everything
    // within tol of its chain chords; this only cleans up the split
    // anchors and duplicate points DP must preserve structurally
    const mergeEpsSq = 1e-6;
    const kept = [];
    for (let i = 0; i < n; i++) {
        if (keep[i]) {
            kept.push(i);
        }
    }
    if (kept.length < min) {
        // DP collapsed the contour below its structural minimum (tiny
        // ring) — return it untouched rather than degenerate
        return points.slice();
    }
    let list = kept.map(i => points[i]);
    let changed = true;
    while (changed && list.length > min) {
        changed = false;
        const m = list.length;
        const out = [];
        for (let i = 0; i < m; i++) {
            if (m - out.length <= min) {
                out.push(list[i]);
                continue;
            }
            if (!closed && (i === 0 || i === m - 1)) {
                out.push(list[i]);
                continue;
            }
            const prev = list[(i - 1 + m) % m], next = list[(i + 1) % m];
            if (segDistSq(list[i], prev, next) < mergeEpsSq) {
                changed = true;
            } else {
                out.push(list[i]);
            }
        }
        if (changed) {
            list = out;
        }
    }
    return list;
}

/**
 * Reassemble the fragments of one clipped wall-finish contour into
 * continuous finish chains (freeAnchorRings wall block).
 *
 * Clipping the wall offset contour on the pixelated clip/stock-matrix
 * boundary (`w.cut(clipBase, true)`) dices it into real segments and
 * sub-0.5mm darts: adjacent fragments of one contour share the boundary
 * crossing vertices, and contour stretches grazing the quantized boundary
 * come back as degenerate 2-point slivers. Each fragment previously
 * emitted as its own short pass (measured 88 dart fragments on the
 * reference ledge plane, all outside the part silhouette).
 *
 * Adjacent open fragments are stitched back together at their touching
 * endpoints (shared crossing vertices, so a tight eps suffices; either
 * orientation — the emitter treats open paths as direction-agnostic),
 * the stitched chains are DP-simplified at the family fragment tolerance
 * to shed the quantization steps, and open chains left with sub-dart 2D
 * extent — pure quantization remnants shaving nothing a real pass
 * reaches — are dropped. The coverage net downstream validates the
 * result and falls back to the legacy rings if the wall band comes up
 * short, so a dropped dart can never silently strand real material.
 *
 * @param {Polygon[]} frags clipped fragments of ONE wall contour
 * @param {number} simpTol DP tolerance for the stitched chains
 * @returns {Polygon[]} whole chains and surviving closed contours
 */
function stitchWallFrags(frags, simpTol) {
    // matches the accept harness's cut-worthiness threshold: below it a
    // path is a dart, not a pass
    const DART = 0.5;
    const eps = ts_eps;
    let out = frags.filter(f => !f.open);
    let open = frags.filter(f => f.open);
    const touch = (a, b) => a.distTo2D(b) <= eps;
    while (open.length) {
        const chain = open.shift();
        let again = true;
        while (again) {
            again = false;
            for (let i = 0; i < open.length; i++) {
                const f = open[i];
                if (touch(f.first(), chain.last())) {
                    chain.addPoints(f.points.slice(1));
                } else if (touch(f.last(), chain.last())) {
                    f.reverse();
                    chain.addPoints(f.points.slice(1));
                } else if (touch(f.last(), chain.first())) {
                    chain.reverse();
                    chain.addPoints(f.points.slice(1));
                } else if (touch(f.first(), chain.first())) {
                    chain.reverse();
                    f.reverse();
                    chain.addPoints(f.points.slice(1));
                } else {
                    continue;
                }
                open.splice(i, 1);
                again = true;
                break;
            }
        }
        out.push(chain);
    }
    const simp = simplifyPolys(out, simpTol);
    return simp.filter(p => {
        if (!p.open) {
            return true;
        }
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of p.points) {
            x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
            y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
        }
        return (x1 - x0) + (y1 - y0) >= DART;
    });
}

/**
 * Simplify a set of polygons (and their holes) with simplifyPoints,
 * returning new polygons. Open polygons and inner holes are handled.
 * Contours that collapse below the structural minimum under
 * simplification are dropped (conservative: shrinking the void is always
 * sound, see freeAnchorRings docblock).
 *
 * @param {Polygon[]} polys
 * @param {number} tol max deviation in mm
 * @returns {Polygon[]}
 */
function simplifyPolys(polys, tol) {
    const out = [];
    for (let poly of polys) {
        const pts = simplifyPoints(poly.points, tol, !poly.open);
        if (pts.length < (poly.open ? 2 : 3)) {
            continue;
        }
        let np = newPolygon();
        for (let p of pts) {
            np.push(p);
        }
        if (poly.open) {
            np.setOpen();
        }
        if (poly.inner?.length) {
            np.inner = simplifyPolys(poly.inner, tol);
        }
        if (poly.depth !== undefined) {
            np.depth = poly.depth;
        }
        out.push(np);
    }
    return out;
}

/**
 * Intersect two polygon sets via a single clipper pass (region ∩ region).
 * Even-odd fill ignores winding but not overlap: inputs must not
 * self-overlap within a set (callers pass unioned/merged sets).
 */
function intersectPolys(setA, setB, z) {
    if (!setA.length || !setB.length) {
        return [];
    }
    let clip = new clib.Clipper(),
        tree = new clib.PolyTree();
    clip.AddPaths(setA.flatMap(p => p.toClipper()), ptyp.ptSubject, true);
    clip.AddPaths(setB.flatMap(p => p.toClipper()), ptyp.ptClip, true);
    clip.Execute(ctyp.ctIntersection, tree, cfil.pftEvenOdd, cfil.pftEvenOdd);
    return POLY.fromClipperTreeUnion(tree, z, 0.01);
}

/**
 * De-staircase raw cleared-cell strips for pixel (matrix) anchoring of the
 * ring family: morphological close of one grid cell radius (round joins
 * avoid miter spikes), then sub-cell Douglas-Peucker simplification with
 * collinear merge (see simplifyPoints). Removes most of the grid
 * staircase but leaves a residue of ~0.25 * resolution amplitude — which
 * is why model-true contours are preferred wherever they verify (see
 * modelFreeEdgeAnchor).
 */
function smoothPixelVoid(polys, z, resolution) {
    const sm = Math.max(resolution, 0.01);
    // fresh opts object per call: POLY.offset accumulates into opts.outs,
    // so a shared object would concatenate the dilate and erode results
    polys = POLY.offset(polys, [ sm ], {
        count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
    });
    polys = POLY.offset(polys ?? [], [ -sm ], {
        count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
    }) ?? [];
    if (!polys.length) {
        return [];
    }
    const tol = Math.max(0.05, 0.25 * resolution);
    return simplifyPolys(polys, tol);
}

/**
 * Resample + moving-average smoothing of closed polygons (and their
 * holes), z preserved. The uniform resample makes the window geometric
 * (samples track arc length, not vertex density), and repeated windowed
 * averaging damps the raster meander — boundary cells of the cleared
 * region alternate cleared/uncleared at 1-5 cell wavelength because the
 * node-based 4-corner cleared test under-credits the swept band by a
 * varying fraction of a cell. The contour shift is bounded by that
 * quantization band (~1.3 cells measured on the reference top plane);
 * most of it recovers area the tool genuinely swept but the corner test
 * refused to credit. Used only on the residual (pass-created) void of
 * modelFreeEdgeAnchor — never on model-true contours.
 *
 * @param {Polygon[]} polys closed polygons
 * @param {number} resolution grid resolution (mm) — sets sample spacing
 * @returns {Polygon[]}
 */
function smoothResidualPolys(polys, resolution) {
    const step = Math.max(resolution, 0.01);
    const HALF = 3, ROUNDS = 4;
    const smoothRing = points => {
        // uniform resample of the closed ring
        const n = points.length;
        const segs = [];
        let total = 0;
        for (let i = 0; i < n; i++) {
            const a = points[i], b = points[(i + 1) % n];
            const l = Math.hypot(b.x - a.x, b.y - a.y);
            segs.push(l);
            total += l;
        }
        const m = Math.max(8, Math.round(total / step));
        let res = [];
        let seg = 0, pos = 0;
        for (let k = 0; k < m; k++) {
            const target = total * k / m;
            while (seg < n - 1 && pos + segs[seg] < target) {
                pos += segs[seg];
                seg++;
            }
            const a = points[seg], b = points[(seg + 1) % n];
            const t = (target - pos) / (segs[seg] || 1e-12);
            res.push([ a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), a.z ]);
        }
        // windowed average rounds
        for (let r = 0; r < ROUNDS; r++) {
            const out = [];
            for (let i = 0; i < m; i++) {
                let sx = 0, sy = 0, sz = 0;
                for (let k = -HALF; k <= HALF; k++) {
                    const q = res[(i + k + m * 4) % m];
                    sx += q[0];
                    sy += q[1];
                    sz += q[2];
                }
                const c = 2 * HALF + 1;
                out.push([ sx / c, sy / c, sz / c ]);
            }
            res = out;
        }
        return res;
    };
    const out = [];
    for (let poly of polys) {
        if (poly.open || poly.points.length < 3) {
            out.push(poly);
            continue;
        }
        let np = newPolygon();
        for (const p of smoothRing(poly.points)) {
            np.push(newPoint(p[0], p[1], p[2]));
        }
        if (poly.inner?.length) {
            np.inner = smoothResidualPolys(poly.inner, resolution);
        }
        out.push(np);
    }
    return out;
}

/**
 * Model-anchored free-edge contours for freeAnchorRings.
 *
 * When a clip's free edge borders a cavity that exists in the model (a
 * ledge overhanging a roughed pocket — the typical alignment target), the
 * smooth model contour of that edge is available directly: a mesh slice
 * just below the cut plane (`shadowAt(cutz - eps)`) cross-sections the
 * cavity, and the inner boundaries of that cross-section are the cavity
 * walls — as smooth as the model's own surfaces, unlike the pixelated
 * strip boundary the rings otherwise anchor to.
 *
 * A hole qualifies as a free-edge contour only when the stock removal
 * model verifies the void it encloses down to the cut plane in the zone a
 * legal axis can cross: the heightmap must show no material rising above
 * the tip plane farther than R + L from the cavity wall (the axis-standoff
 * band is unflyable by construction — `safe` excludes shadow ⊕ (R + L) —
 * and holds the intentional leave shell). Two forgiveness classes keep
 * real-world planes from spuriously failing that check:
 *   - wall/standoff band material (see above), and
 *   - quantization slivers within one grid cell of the verified void
 *     boundary (cells straddling a cleared/material boundary never pass
 *     the 4-corner cleared test — the same class the coverage net
 *     forgives via `vquiet`).
 * An unverified hole core (under-roughed cavity the rings would hang
 * their axes over) still rejects the model anchor for the whole plane —
 * the caller falls back to pixel anchoring, which never trusts model-true
 * contours.
 *
 * Void the matrix verifies beyond the model contours (air created by the
 * passes themselves rather than by model geometry, e.g. facing near the
 * stock top) is returned merged in, de-staircased with the pixel path, so
 * those free edges keep smoothed anchoring while the model contours stay
 * exact — but only a full de-staircase step away from the part wall.
 * Anchor edges bordering the part wall are sourced from the smooth model
 * silhouette (the cross-section regions and their one-cell exterior band,
 * matrix-verified with the same quiet forgiveness) rather than the
 * de-staircased raster: wall-straddling cells never verify cleared, so the
 * raster boundary there carries up-to-one-cell wiggle that would propagate
 * into every ring anchored on it. where the silhouette band carries a
 * rising wall (material above the cut plane), the band fails verification
 * and the wall-adjacent raster void is dropped from the anchor entirely —
 * the wall standoff ring covers that band.
 *
 * @param {Object} ctx
 * @param {Function} ctx.shadowAt async widget shadow query (cached per z)
 * @param {number} ctx.cutz world z of the actual cut plane (no flatOff)
 * @param {Polygon[]} ctx.reach tool-reach zone voidPolys were gathered in
 * @param {Polygon[]} ctx.voidPolys raw (un-smoothed) verified void regions
 * @param {number} ctx.z world z for generated anchor polys
 * @param {number} ctx.resolution stock heightmap grid resolution
 * @param {number} ctx.R tool radius (flute diameter / 2)
 * @param {number} ctx.L leave_xy wall allowance
 * @returns {Promise<{void:Polygon[],mat:Polygon[]}|undefined>} anchor
 *   region groups (`void`: verified/residual void regions driving the
 *   free-edge progression; `mat`: model cross-section regions seeding
 *   silhouette-adjacent rings), or undefined to fall back to pixel
 *   anchoring
 */
async function modelFreeEdgeAnchor(ctx) {
    const { shadowAt, cutz, reach, voidPolys, z, resolution, R, L } = ctx;

    // slice the mesh just below the cut plane: inner boundaries of the
    // cross-section are walls of cavities existing in the model at this
    // depth. shadowAt caches per z and must not be mutated: clone holes
    // before any winding fix-up
    let below = await shadowAt(cutz - 0.01);
    let holes = [];
    for (let poly of below) {
        if (!poly.inner?.length) {
            continue;
        }
        for (let hole of poly.inner) {
            // the clipper tree guarantees hole winding opposite its parent
            // outer; normalize to the outer winding so POLY.offset treats
            // the hole like any void REGION (positive offset dilates into
            // material, matching the pixel-void offset semantics). inner
            // windings are re-fixed by POLY.offset itself
            let hc = hole.clone(true);
            if (hc.isClockwise() === poly.isClockwise()) {
                hc.reverse();
            }
            holes.push(hc);
        }
    }
    if (!holes.length) {
        return undefined;
    }
    // candidates: model cavities the verified void actually overlaps — a
    // free edge of this clip can only border verified void, so untouched
    // cavities elsewhere in the area are not anchors (and not failures)
    let candidates = [];
    for (let hole of holes) {
        let ov = intersectPolys([ hole ], voidPolys, z);
        let ovA = ov.reduce((a, p) => a + p.areaDeep(), 0);
        if (ovA > 0.25 * resolution * resolution) {
            candidates.push(hole);
        }
    }
    if (!candidates.length) {
        return undefined;
    }
    // verification: within the model contour (clipped to the reach, where
    // the matrix carries data) the matrix must verify void down to the
    // tip plane wherever a legal axis can travel. two forgiveness classes
    // match what the tool can actually reach and what the matrix can
    // actually represent:
    //   - the axis-standoff band: no legal axis exists within R + L of
    //     the cavity wall (`safe` excludes shadow ⊕ (R + L), and the
    //     cavity wall rises through the cut plane or sits under overhang
    //     material in the shadow), so material there is the intentional
    //     leave shell or unsweepable residue — verify only the core
    //     farther than R + L from the wall;
    //   - quantization slivers: cells straddling the cleared/material
    //     boundary never pass the 4-corner cleared test, leaving phantom
    //     material up to one grid cell wide along every free edge — the
    //     same class the coverage net forgives via `vquiet`. forgive
    //     material within one grid cell of the verified void boundary.
    // unverified material in the core — stock the rings would hang axes
    // over or face at full depth — still rejects the model anchor for
    // this plane (conservative rollback to pixel anchoring)
    let verified = [];
    let quiet = POLY.offset(voidPolys, [ resolution + ts_eps ], {
        count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
    }) ?? [];
    for (let hole of candidates) {
        let hr = intersectPolys([ hole ], reach, z);
        if (!hr.length) {
            continue;
        }
        let core = POLY.offset(hr, [ -(R + L + ts_eps) ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
        if (!core.length) {
            // entire cavity within the standoff band: no legal axis
            // crosses its interior, nothing to verify
            verified.appendAll(hr);
            continue;
        }
        let rem = [];
        POLY.subtract(core, quiet, rem, undefined, z, 0);
        let remA = rem.reduce((a, p) => a + p.areaDeep(), 0);
        if (typeof process !== 'undefined' && process.env.FARRV) {
            const bb = ps => {
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                for (let p of ps) for (let q of p.points) {
                    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
                    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
                }
                return `x[${x0.toFixed(2)},${x1.toFixed(2)}] y[${y0.toFixed(2)},${y1.toFixed(2)}]`;
            };
            console.log(`[FARRV] z=${z} hole=${bb([ hole ])} hr=${bb(hr)} core=${bb(core)} remA=${remA.toFixed(3)}`);
        }
        if (remA > 0.05) {
            return undefined;
        }
        verified.appendAll(hr);
    }
    if (!verified.length) {
        return undefined;
    }
    // void beyond the model contours keeps pixel anchoring — except along
    // the part wall. the raster void boundary there sits up to a grid cell
    // off the model silhouette (wall-straddling cells never verify cleared:
    // the same quantization class the core verification forgives) and its
    // de-staircase residue propagates into every family ring anchored on
    // it (measured median zigzag 0.54 mm on the reference top plane). so
    // the wall-adjacent anchor edge is sourced from the model silhouette:
    // the cross-section regions (outer contour + cavities) are model-true
    // and join the anchor in full. this is safe without a matrix check:
    // wherever the cross-section band carries material rising above the
    // cut plane it IS the shadow at that plane, and the caller's safe-zone
    // clip (shadow ⊕ R + L) kills every ring segment crossing it; where it
    // does not rise (the top plane leveling pass), rings over it are the
    // intended leveling trace — the matrix cannot verify that band anyway,
    // since it only tracks removed stock and untouched skin reads as
    // virgin. pixel-smoothed residual is kept a full de-staircase step
    // beyond the model region, so its residue can never wiggle the
    // silhouette-adjacent anchor edge
    let silRegion = below.map(poly => poly.clone(true));
    // merged keep-away basis for the residual boundary below only. this
    // union erases the void|material free-edge contour (verified void and
    // the cross-section share the cavity wall boundary), so it must never
    // reach the anchor itself — see the split at the end of this function
    let modelAll = POLY.union([ ...verified, ...silRegion ], 0.00001, true);
    // outward excursion the pixel de-staircase can produce relative to the
    // raw strips: one close cell (smoothPixelVoid dilate/erode radius) plus
    // the sub-cell simplify tolerance
    let smoothTol = Math.max(0.05, 0.25 * resolution);
    let modelBig = POLY.offset(modelAll, [ resolution + smoothTol + ts_eps ], {
        count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
    }) ?? [];
    let residual = [];
    POLY.subtract(voidPolys, modelBig, residual, undefined, z, 0);
    // forgive phantom-material bays before de-staircasting: the 4-corner
    // cleared test leaves un-cleared cells (up to two grid cells wide)
    // attached to the verified void at slab boundaries and at the heightmap
    // grid edge (measured 1x2-cell notches on the reference top plane).
    // smoothPixelVoid's one-cell close cannot fill bays whose mouth is a
    // full two cells wide, and the surviving peninsula residue propagates
    // into every family ring anchored on the boundary (measured 0.29 mm
    // median zigzag). a close one cell + eps wider fills bays up to two
    // cells across without moving the residual boundary outward more than
    // one cell; the rings' engagement/coverage checks still run against
    // the raw matrix, so nothing real gets silently excused here
    if (residual.length) {
        const fq = resolution + ts_eps;
        residual = POLY.offset(residual, [ fq ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
        residual = POLY.offset(residual ?? [], [ -fq ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
    }
    // de-staircase the residual with the same one-cell morphological close
    // smoothPixelVoid uses, but WITHOUT its Douglas-Peucker pass: DP
    // sparsifies the boundary to ~1-3mm vertex spacing and the simplified
    // chords then swing up to the DP tolerance (0.25 * resolution) off the
    // true boundary — measured 0.29-0.39 mm median zigzag on the reference
    // top plane, propagated 1:1 into every family ring anchored on the
    // residual boundary (pooled plane median 0.133 mm > 0.1 acceptance).
    // the close alone leaves a dense cell-aligned boundary (measured
    // 0.014 mm median, same ~0.29 mm max outward excursion): its round-join
    // arcs already de-staircase the corners, and the family rings inherit
    // no chord swing. the ring-level simplify below still bounds path size
    let smooth = [];
    if (residual.length) {
        const sm = Math.max(resolution, 0.01);
        let sp = POLY.offset(residual, [ sm ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        });
        sp = POLY.offset(sp ?? [], [ -sm ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
        // the rasterized sweep boundary still meanders: the node-based
        // 4-corner cleared test under-credits the swept band by a varying
        // fraction of a cell, so the boundary cells alternate
        // cleared/uncleared at 1-5 cell wavelength — and offsetting
        // preserves that wave 1:1, so family rings anchored on it kept a
        // ~0.14 mm median zigzag (DP or not, measured 0.133-0.150 pooled
        // on the reference top plane). resample + moving-average damps
        // the meander to a ~0.02 mm median ring zigzag; the contour shift
        // stays inside the quantization band (~1.3 cells, mostly
        // recovering area the tool actually swept — see helper docblock)
        smooth = smoothResidualPolys(sp, resolution);
    }
    // the anchor is returned as two separate region groups. unioning them
    // would erase their shared void|material boundary — the model-true
    // free-edge contour the family anchors on (measured on the reference
    // ledge plane: union(verified, silRegion) absorbs the deep-cavity hole,
    // modelAll inner=0, and no ring ever advances over the ledge from its
    // free edge). the void group drives the free-edge progression (its
    // boundary offset by +c advances into the material). the material group
    // reproduces the merged-anchor behavior for silhouette-adjacent rings:
    // eroded while c < 0 (face pass inward from the part outline on facing
    // planes), dilated at c >= 0 (clearing the stock band outside the
    // part). its verified free-edge holes are dropped — the void group's
    // boundary is that same contour and a material-side copy would
    // double-cut the same band; unverified cavity holes keep the
    // merged-anchor ring behavior
    let matAnchor = silRegion.map(poly => {
        let c = poly.clone(true);
        if (c.inner?.length) {
            c.inner = c.inner.filter(h => !candidates.some(cand => h.isEquivalent(cand)));
        }
        return c;
    });
    // union before merge (even-odd overlap hazard): verified and the
    // de-staircased residual are disjoint by construction (residual is
    // kept a full de-staircase step beyond the model region)
    const out = POLY.union([ ...verified, ...smooth ], 0.00001, true);
    if (typeof process !== 'undefined' && process.env.FARRD &&
        Math.abs(cutz - parseFloat(process.env.FARRDZ || 30)) < 0.001) {
        const dump = polys => polys.map(p => ({
            outer: p.points.map(q => [ +q.x.toFixed(3), +q.y.toFixed(3) ]),
            inner: (p.inner || []).map(h => h.points.map(q => [ +q.x.toFixed(3), +q.y.toFixed(3) ])),
        }));
        console.log(`[FARRD] ${JSON.stringify({
            silRegion: dump(silRegion),
            verified: dump(verified),
            voidPolys: dump(voidPolys),
            modelAll: dump(modelAll),
            modelBig: dump(modelBig),
            residual: dump(residual),
            smooth: dump(smooth),
            anchor: dump(out),
            matAnchor: dump(matAnchor),
        })}`);
    }
    return { void: out, mat: matAnchor };
}

/**
 * Void-anchored clearing ring generation (free-edge first machining).
 *
 * Distinguishes the two kinds of edges a clear-mode clip can have:
 *
 *   - OCCUPIED edge: borders material rising above the cut plane (the
 *     part cross-section, `shadow`). The tool axis must keep a standoff
 *     of R + leave from it — the legacy `firstOff` ring anchor.
 *   - FREE edge: borders material the stock removal model (heightmap)
 *     verifies as already removed down to this op's tip plane. The tool
 *     disk may overhang such an edge: the axis may travel over verified
 *     void as long as the disk still engages fresh material.
 *
 * The generated ring set replaces the legacy wall-anchored progression:
 *
 *   ring 1 sits at min(S - R, 0) from the free edge: over model-verified
 *     air when S < R (disk engages ~S of fresh material), or exactly on
 *     the edge when S >= R (disk engages at most R — 50% radial
 *     immersion — since the axis never crosses into fresh material);
 *   rings advance by S toward the occupied wall, each removing ~min(S, R)
 *     of new material (no full-width passes, no idle rings over void);
 *   the family stops at the first ring with no fresh material to cut,
 *     a ring entirely outside the safe axis zone, or the `steps` cap;
 *   the wall-anchored ring(s) — anchored on the shadow dilated by
 *     R + leave (axis space), i.e. the boundary of the forbidden axis
 *     zone, with the finish_cut variant dilated further — are appended
 *     last, so the wall gets a light finishing pass even on narrow
 *     shelves where a clip-anchored (legacy firstOff) ring would collapse;
 *     they are clipped to the op clip (`clipBase`), never to `safe`
 *     (coincident-edge kill) or `reach` (lets the disk wander R beyond
 *     the working area on outer walls)
 *
 * Every candidate ring is constrained before emission:
 *   - family rings are intersected with the "safe" axis zone = tool
 *     reach of the clip (clip dilated by R) minus the shadow dilated by
 *     R + leave, so no axis point ever sits closer than R + leave to
 *     material above the cut plane, then capped at the op clip itself
 *     (rings advancing outward from the free edge would otherwise sweep
 *     air up to R beyond the working area — #2a1a05fa); wall rings are
 *     clipped to the op clip as well;
 *   - engagement-checked against the remaining material (`mat` = clip
 *     minus verified void): a ring whose disk removes no fresh material
 *     ends the family instead of being emitted as an idle pass.
 *
 * The stock model's cleared-cell strips are a pixelated (heightmap grid)
 * approximation of the void. They serve two distinct roles here:
 *
 *   - ANCHOR for the family rings. When the free edge borders a cavity
 *     that exists in the model (a ledge overhanging a roughed pocket),
 *     the exact smooth model contour of that edge is used instead (see
 *     modelFreeEdgeAnchor): rings become offsets of the model contour and
 *     carry no pixel wiggle. Only when no model contour verifies does the
 *     pixel path anchor the rings: strips are unioned and closed (dilate
 *     + erode by one grid cell) to de-staircase the free-edge boundary
 *     without moving it outward, leaving a residual ~0.25 * resolution
 *     wave (see smoothPixelVoid). Undercounted void (conservative corner
 *     test in clearedRegion) only shrinks the allowed overhang, never
 *     extends it.
 *   - VERIFICATION and honesty: `mat` (remaining material), the
 *     engagement checks and the coverage net are always computed against
 *     the raw strip union — the matrix is never smoothed up to excuse
 *     uncut material.
 *
 * A coverage net guards against pathological geometry: when the
 * generated set (family + wall rings) leaves more material uncut than a
 * generous threshold, the caller keeps the legacy rings, which always
 * cover the full clip by construction.
 *
 * @param {Object} ctx
 * @param {StockModel} ctx.stockModel valid stock removal model
 * @param {Polygon[]} ctx.clip working clip (post skipclear reduction)
 * @param {Polygon[]} ctx.clipBase full clip before reduction (or clip)
 * @param {Polygon[]} ctx.shadow part cross-section at the cut plane
 * @param {number} ctx.tipz effective tip plane for model queries
 * @param {number} ctx.cutz world z of the actual cut plane (no flatOff)
 * @param {number} ctx.z world z for generated path polys
 * @param {number} ctx.R tool radius (flute diameter / 2)
 * @param {number} ctx.L leave_xy wall allowance
 * @param {number} ctx.S stepover (any value <= 2R is coverable; the
 *   family start is clamped to the free edge when S >= R)
 * @param {number} ctx.firstOff legacy first offset, -(R + L)
 * @param {number} ctx.finishCut legacy finish_cut offset (0 = none)
 * @param {Object} ctx.offopt shared POLY.offset options
 * @param {number} ctx.steps ring count cap (op.steps)
 * @param {Function} ctx.shadowAt async widget shadow query (cached per z)
 * @returns {Promise<Polygon[]|undefined>} replacement ring set, or
 *   undefined to keep the legacy rings
 */
/**
 * Stamp the authored emission order onto a generated path set. `k` is the
 * index in the authored array (0 = cut first). The poly emitter (see
 * prepare.js descend() and poly2polyEmit's inOrder mode) outputs stamped
 * polys in ascending farrSeq instead of greedy nearest-neighbor routing,
 * which otherwise re-orders the set by proximity to the tool's arrival
 * point — emitting the wall finish ring (and its full-radial plunge into
 * uncut material) first whenever the tool happens to arrive near the wall
 * (task #03afbbf1). Unstamped sets keep the greedy routing.
 *
 * @param {Polygon[]} outs authored-order path set
 * @returns {Polygon[]} the same array, stamped
 */
function stampFarrSeq(outs) {
    const stamp = (p, s) => {
        p.farrSeq = s;
        if (p.inner) {
            for (let q of p.inner) {
                stamp(q, s);
            }
        }
    };
    for (let i = 0; i < outs.length; i++) {
        stamp(outs[i], i);
    }
    return outs;
}

async function freeAnchorRings(ctx) {
    const { stockModel, clip, clipBase, shadow, tipz, cutz, z, R, L, S, firstOff, finishCut, offopt, steps, shadowAt } = ctx;

    // axis-safe zone: within tool reach of the clip, clear of the shadow
    // dilated by the tool radius + wall allowance
    let reach = POLY.offset(clipBase, [ R + ts_eps ], { count: 1, flat: true, z, ...offopt, minArea: 0.01 });
    if (!reach.length) {
        return undefined;
    }
    // verified void within reach: heightmap cells swept to/below this
    // op's tip plane by prior operations
    let voidRaw = stockModel.clearedRegion(reach, tipz);
    if (!voidRaw.length) {
        return undefined;
    }
    // union the strips before further use: the raw strip list is one rect
    // per grid-row run (thousands of rects over a cleared cavity) and
    // ClipperOffset processes every input path independently, so any
    // offsetting of the merged (perimeter-only) contour set is much
    // cheaper. exact: offset(A u B, d) = offset(A, d) u offset(B, d).
    // single clipper pass: pairwise POLY.union is quadratic in strip count
    let cuni = new clib.Clipper(),
        ctree = new clib.PolyTree();
    cuni.AddPaths(voidRaw.flatMap(p => p.toClipper()), ptyp.ptSubject, true);
    cuni.Execute(ctyp.ctUnion, ctree, cfil.pftEvenOdd, cfil.pftEvenOdd);
    let voidPolys = POLY.fromClipperTreeUnion(ctree, z, 0.01);
    if (!voidPolys.length) {
        return undefined;
    }
    // ring anchor selection. model-true free-edge contours (mesh slice
    // just below the cut plane, verified against the matrix) take
    // precedence: rings anchored on them carry no pixel wiggle, and the
    // pixel de-staircase (union close + DP) is skipped entirely. voidMat
    // stays the raw strip union in that case: mat/engagement/coverage
    // below are computed against the un-smoothed matrix, so the generated
    // set is never excused by smoothing
    let anchor, voidMat;
    let modelAnchor = await modelFreeEdgeAnchor({
        shadowAt, cutz, reach, voidPolys, z, resolution: stockModel.resolution, R, L
    });
    let farBB = ps => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let p of ps) for (let q of p.points) {
            x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
            y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
        }
        return `x[${x0.toFixed(2)},${x1.toFixed(2)}] y[${y0.toFixed(2)},${y1.toFixed(2)}]`;
    };
    console.log(`[FAR] z=${z} cutz=${cutz} R=${R} L=${L} modelAnchor=${modelAnchor ? "YES" : "no-pixel"} voidPolys=${voidPolys.length} clip=${farBB(clipBase)}` +
        (typeof process !== 'undefined' && process.env.FARRS ?
            ` stock=${farBB([ newPolygon().centerRectangle({ x: (stockModel.bounds.min.x + stockModel.bounds.max.x) / 2, y: (stockModel.bounds.min.y + stockModel.bounds.max.y) / 2 }, stockModel.bounds.max.x - stockModel.bounds.min.x, stockModel.bounds.max.y - stockModel.bounds.min.y) ].map(p => { p.setZ(z); return p; }))}` : ''));
    // e2e-observable record of the anchor decision and the working-clip
    // envelope per plane: the harness asserts modelAnchor YES/NO per flat
    // and that no emitted path point leaves the clip (#2a1a05fa)
    (stockModel.widget.farAnchorLog ??= []).push({
        z, cutz, modelAnchor: !!modelAnchor, clip: farBB(clipBase)
    });
    if (typeof process !== 'undefined' && process.env.FARRP) {
        const boxPoly = (b) => {
            const p = new (clipBase[0].constructor)();
            p.points.push({ x: b[0], y: b[2], z }, { x: b[1], y: b[2], z }, { x: b[1], y: b[3], z }, { x: b[0], y: b[3], z });
            return p;
        };
        const probe = (b) => stockModel.clearedRegion([ boxPoly(b) ], tipz)
            .reduce((a, p) => a + p.areaDeep(), 0).toFixed(1);
        console.log(`[FARRP] z=${cutz} tipz=${tipz} cavityMid=${probe([0, 5, 0, 5])} cavityRim=${probe([42, 46, 0, 3])} wideRing=${probe([10, 30, 0, 10])} outside=${probe([53, 56, 0, 3])}` +
        (process.env.FARRPB ? ` band=${probe(process.env.FARRPB.split(',').map(Number))}` : ''));
    }
    let anchorMat = [];
    if (modelAnchor) {
        anchor = modelAnchor.void;
        anchorMat = modelAnchor.mat;
        voidMat = voidPolys;
    } else {
        // de-staircase the strip union for anchoring (see docblock):
        // morphological close of one grid cell + sub-cell DP simplify.
        // the smoothed void may extend the raw void by at most tol;
        // mat/engagement/coverage below are all computed from these same
        // smoothed contours, so they stay consistent
        voidPolys = smoothPixelVoid(voidPolys, z, stockModel.resolution);
        if (!voidPolys.length) {
            return undefined;
        }
        voidMat = voidPolys;
        // anchor inflation: cells straddling the true free edge never pass
        // the 4-corner cleared test, so the strip boundary (and thus this
        // anchor) sits up to one grid cell inside the model edge — and
        // rings hung (R - S) inside it leave a matching uncut band along
        // the edge. inflate the ANCHOR only by one grid cell (never
        // `voidMat`: mat/engagement/coverage below stay honest against the
        // un-inflated matrix, see docblock) so the anchor boundary sits on
        // the model edge; the first ring then hangs (R - S) inside the
        // true edge and its disk sweep reaches S past it instead of
        // falling up to one cell short. the axis stays over verified void
        // whenever R - S > resolution; for S >= R it rides the inflated
        // boundary — at most one phantom cell out, the same quantization
        // class the coverage net already forgives (vquiet below)
        anchor = POLY.offset(voidPolys, [ stockModel.resolution ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? voidPolys;
        // silhouette-adjacent rings for the pixel path, same role the
        // model path's material group plays (see family loop below): the
        // void group anchors nothing on the part outline, so its rings
        // reach the silhouette only as clipped remnants of cavity-rim
        // offsets — the outermost one trims the outline band with a
        // standoff that wanders with the local rim width (measured
        // 0.003-2.013 mm on the reference top plane, pooled MAD 0.149 mm
        // against the 0.1 acceptance). the mesh cross-section just below
        // the cut plane is model-true and needs no matrix verification:
        // wherever it carries material rising above the cut plane it is
        // the shadow, and the safe-zone clip (shadow ⊕ R + L) kills every
        // ring segment crossing it; where it does not rise (the top-plane
        // leveling pass) rings over it are the intended leveling trace —
        // the same reasoning that lets the model path join silRegion to
        // its anchor unchecked. its holes are dropped regardless of
        // verification: hole rims the void group does not ring stay
        // unrung, as before this seeding existed
        anchorMat = (await shadowAt(cutz - 0.01)).map(poly => {
            let c = poly.clone(true);
            c.inner = [];
            return c;
        });
    }
    const tol = Math.max(0.05, 0.25 * stockModel.resolution);
    // material remaining at this plane inside the clip
    let mat = [];
    POLY.subtract(clipBase, voidMat, mat, undefined, z, 0.01);
    if (!mat.length) {
        return undefined;
    }
    // the stock removal matrix covers the widget bounds only; beyond them
    // `mat` (clip minus verified void) reads the never-modeled stock margin
    // as phantom material. by the time this op's later pass runs, that band
    // was already cut to the stock floor by the earlier pass (its clip
    // covers the full stock), so anchoring or net-accounting it only
    // produces air-cutting junk fragments riding the clip boundary
    // (measured 12-28 fragments beyond the part silhouette on the
    // reference planes). constrain mat to the modeled domain, one grid
    // cell of slack for the boundary-straddling cell class the 4-corner
    // cleared test never verifies
    {
        const b = stockModel.bounds;
        // no slack: the matrix carries no cells beyond its bounds, so any
        // material read there is the never-modeled margin (physically
        // already cut to this plane by the previous pass's own paths — its
        // clip covers the full stock). a slack band here re-arms that blind
        // strip as phantom fresh material and family/wall offsets anchored
        // on the domain-edge void boundary ride it as junk fragments
        // (measured 40 fragments beyond the part silhouette on the
        // reference ledge plane)
        const mslack = 0;
        const matDom = newPolygon().centerRectangle(
            { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 },
            (b.max.x - b.min.x) + 2 * mslack,
            (b.max.y - b.min.y) + 2 * mslack
        );
        matDom.setZ(z);
        const matIn = intersectPolys(mat, [ matDom ], z);
        if (matIn.length) {
            mat = matIn;
        }
    }
    // quantization forgiveness zone (see net below): everything within one
    // grid cell of the verified void. also the adjacency probe for the
    // coverage domain
    let vquiet = POLY.offset(voidMat, [ stockModel.resolution + ts_eps ], {
        count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
    }) ?? [];
    // anchor-based forgiveness zone (model-anchor planes only): everything
    // within one grid cell of the SELECTED anchor boundary. the anchor
    // de-staircases/free-edge-exact contours ride across phantom-material
    // bays the raw matrix carries (measured: 2-cell-deep un-cleared rows
    // hugging the part wall at concave silhouette stretches — twice the
    // reach of the void-based `vquiet`, since the void boundary itself
    // sits a cell or more off the wall there). family/wall rings anchored
    // on the anchor boundary necessarily sweep those bays; their phantom
    // engagement re-arms junk fragments (measured: the material-group
    // silhouette ring on the reference ledge plane found 249 mm^2 of pure
    // wall-hugging slivers and emitted as an air-cutting pass 5.6 mm
    // outside the part). the raw matrix stays the engagement SOURCE (mat
    // is untouched) and the coverage net still runs against it, so real
    // material is never excused — this only stops phantom slivers from
    // arming ring emission
    let aquiet = [];
    if (modelAnchor) {
        aquiet = POLY.offset(anchor, [ stockModel.resolution + ts_eps ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
    }
    // matrix-domain-edge quiet band: the last cell column/row inside the
    // matrix bounds. cells there straddle the prior sweeps' contours at the
    // grid edge and fail the 4-corner cleared test like any boundary cell,
    // leaving phantom slivers up to a cell wide hugging the domain edge —
    // physically long since cut (the whole-stock rough clears the margin
    // before the flats pass runs). un-forgiven, they re-arm as fresh
    // material: rings anchored on the domain-edge void boundary ride them
    // as junk fragments outside the part silhouette (measured 40 on the
    // reference ledge plane, engagement 0.1-11 mm^2 of pure edge slivers).
    // same forgiveness class as vquiet; real material within the band stays
    // cut — it is inside the ledge/wall rings' sweep by construction
    let edgeQuiet = [];
    {
        const b = stockModel.bounds;
        const edom = newPolygon().centerRectangle(
            { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 },
            (b.max.x - b.min.x) + ts_eps, (b.max.y - b.min.y) + ts_eps
        );
        edom.setZ(z);
        const ecore = POLY.offset([ edom ], [ -(stockModel.resolution + ts_eps) ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
        if (ecore.length) {
            POLY.subtract([ edom ], ecore, edgeQuiet, undefined, z, 0);
        }
    }
    // coverage accounting domain: mat regions adjoining the verified void —
    // the material the free-edge design (family + wall rings) is responsible
    // for. clipBase can also carry material no ring of the generated set
    // targets and the legacy progression skips as well: the op area is the
    // part shadow dilated by R (tool reach), so the clip holds an R-wide
    // band outside the part silhouette at every plane below the stock top.
    // that band's legacy offset ring (firstOff = R + L > band width) always
    // collapses, and the next rough plane cuts the band — but counting it
    // in the net would reject every generated set on such planes, silently
    // degrading the free edge back to the legacy wall-anchored rings (the
    // uncut ledge strip this feature exists to remove). mat components
    // isolated from the void by the shadow are exactly that class; anything
    // connected to void-adjacent material stays in the domain, under the net
    let dom = [];
    for (let m of mat) {
        if (!vquiet.length) {
            break;
        }
        let ov = intersectPolys([ m ], vquiet, z);
        let ovA = ov.reduce((a, p) => a + p.areaDeep(), 0);
        if (ovA > 0.01) {
            dom.push(m);
        }
    }
    if (!dom.length) {
        { console.log(`[FARRX] z=${z} exit: dom empty`); return undefined; }
    }
    // flat:true offsets return undefined (not []) when they produce no
    // polygons, so coalesce to an empty array before use
    let forb = POLY.offset(shadow, [ R + L + ts_eps ], { count: 1, flat: true, z, ...offopt, minArea: 0.01 }) ?? [];
    let safe = [];
    POLY.subtract(reach, forb, safe, undefined, z, 0.01);
    if (!safe.length) {
        { console.log(`[FARRX] z=${z} exit: safe empty`); return undefined; }
    }

    // sweep a ring fragment (open or closed) by the tool radius into the
    // region its disk would touch
    const sweepOf = (frag) => {
        if (frag.open) {
            return frag.clone(true).offset_open(R, 'round', 2, sweepArc);
        }
        // closed ring: the true swept region is the annulus between the
        // ring dilated and eroded by the tool radius. a plain positive
        // offset returns the dilated REGION contour — used directly as the
        // sweep, its interior spans the ring's whole content, so any ring
        // enclosing material claimed all of it as engaged (measured on the
        // reference ledge plane: the material-group silhouette ring claimed
        // 249 mm^2 of ledge its disk never touches and emitted as an
        // air-cutting pass outside the part silhouette; the same
        // disc-interior accounting armed the junk outside fragments this
        // feature's earlier revisions kept fighting). void-anchored rings
        // got the same answer by accident: their disc interior is verified
        // void, leaving only the true band
        let outer = POLY.offset([ frag ], [ R ], { count: 1, flat: true, z, ...offopt, minArea: 0 }) ?? [];
        if (!outer.length) {
            return [];
        }
        let inner = POLY.offset([ frag ], [ -R ], { count: 1, flat: true, z, ...offopt, minArea: 0 }) ?? [];
        if (!inner.length) {
            return outer;
        }
        let band = [];
        POLY.subtract(outer, inner, band, undefined, z, 0);
        return band.length ? band : outer;
    };

    // family rings anchored on the selected free-edge boundary (smooth
    // model contours when they verified, de-staircased pixel boundary
    // otherwise). cumulative offset c starts at min(S - R, 0): the first
    // ring's axis sits S - R beyond the free edge (over verified void,
    // engaging ~S of fresh material) when S < R, or exactly on the free
    // edge when S >= R — the disk then engages at most R (50% radial
    // immersion), and later rings advance by S toward the occupied wall,
    // keeping each ring's fresh band at ~min(S, R)
    let rings = [];
    let keptSrc = []; // per-ring anchor source tag (V=void group, M=mat group)
    let removed = []; // swept fresh material of emitted rings so far
    let minEng = S * S * 0.001; // ~zero fresh-material threshold
    let c = Math.min(S - R, 0);
    for (let k = 0; k < steps; k++, c += S) {
        let raw = POLY.offset(anchor, [ c ], { count: 1, flat: true, z, ...offopt }) ?? [];
        let rawSrc = raw.map(() => 'V');
        // model material regions seed the silhouette-adjacent rings the
        // void group cannot produce (face pass inward from the part
        // outline on facing planes at c < 0, stock-band clearing outward
        // at c >= 0) — the exact behavior the merged model anchor had
        // before the void/material split
        if (anchorMat.length) {
            let mr = POLY.offset(anchorMat, [ c ], { count: 1, flat: true, z, ...offopt }) ?? [];
            raw.appendAll(mr);
            rawSrc.appendAll(mr.map(() => 'M'));
        }
        if (!raw.length) {
            break;
        }
        // keep only the path inside the safe axis zone (drops wall-side
        // violations and out-of-reach wander; may split rings into open
        // fragments, which the emitter handles like any open polyline).
        // simplify each fragment so emitted paths carry no residual
        // per-cell jitter introduced by the safe-zone clipping. the
        // tolerance tracks the anchor source: the pixel path's rings are
        // raster-derived, so the sub-cell DP tolerance applies — but the
        // model path's rings are exact model-contour offsets, where the
        // pixel tolerance would re-introduce ~0.25 mm of zigzag on every
        // family ring (measured 0.54 mm pooled median on the reference
        // top plane) — there a tight tolerance only strips the clip
        // vertices and keeps the rings model-true
        let frags = [];
        let fragSrc = [];
        for (let ri = 0; ri < raw.length; ri++) {
            let r = raw[ri];
            let cut = r.cut(safe, true);
            if (!cut) {
                continue;
            }
            // cap the family at the working clip: rings advancing outward
            // from the free edge would otherwise wander up to R past the
            // clip boundary (safe only caps at reach = clip ⊕ R), sweeping
            // air beyond the working area — the same defect the wall rings
            // shed in #2a1a05fa. material inside the clip edge band stays
            // covered: any axis point of the cap's inner side reaches it,
            // and the coverage net below validates the result
            let capped = [];
            for (let f of cut) {
                let c2 = f.cut(clipBase, true);
                if (c2) capped.appendAll(c2);
            }
            if (capped.length) {
                for (let f of capped) {
                    // the tolerance tracks the ring source, not the plane
                    // anchor: model-contour (M) rings stay model-true even
                    // when the plane rolled back to the pixel anchor, where
                    // the sub-cell DP tolerance would re-introduce ~0.25 mm
                    // of zigzag on them (see comment above)
                    let simp = simplifyPolys([ f ], (modelAnchor || rawSrc[ri] === 'M') ? ts_eps : tol);
                    frags.appendAll(simp);
                    fragSrc.appendAll(simp.map(() => rawSrc[ri]));
                }
            }
        }
        if (!frags.length) {
            // family reached the safe boundary everywhere: ring axes move
            // monotonically outward from the void as c grows, so once an
            // offset lands entirely inside the forbidden zone (or beyond
            // reach) every later offset lands deeper — no later c can
            // produce a legal fragment again. the wall ring(s) anchored
            // on the safe boundary cover the final stepover band
            break;
        }
        // fresh-material engagement: sweep each fragment by the tool
        // radius, intersect (region ∩ region via mask) with remaining
        // material, drop already-cut. on model-anchor planes the
        // accounting is per fragment: a fragment whose sweep removes no
        // real fresh material is dropped instead of riding along with its
        // level — anchor contours dilating over matrix-verified void
        // outside the part (the clip-edge band) would otherwise emit as
        // sliver-cutting junk fragments (measured 12-28 fragments beyond
        // the silhouette on the reference ledge plane). mask/subtract
        // results overlap, so every stage is unioned before boolean use:
        // POLY.subtract runs even-odd, and overlapping input regions would
        // punch phantom holes into the result instead of merging
        let fresh = []; // per-fragment fresh (sweep ∩ mat − removed) pieces
        let kept = []; // fragments with real fresh material to cut
        let keptRaw = []; // full sweep-over-material of kept fragments
        for (let fi = 0; fi < frags.length; fi++) {
            let frag = frags[fi];
            let fh = [];
            for (let sw of sweepOf(frag)) {
                for (let m of mat) {
                    let hit = sw.mask(m);
                    if (hit) fh.appendAll(hit);
                }
            }
            if (!fh.length) {
                continue;
            }
            let feng = fh;
            if (removed.length) {
                // strictlySimple: false — the engagement result only feeds
                // the fresh-area test (and `removed` feeds the coverage
                // net's even-odd passes); the strictly-simple post-pass is
                // quadratic on the pixel-matrix contours this loop runs
                // against and has measured 60s+ per plane at fine stock
                // resolutions
                let fe = [];
                POLY.subtract(fh, removed, fe, undefined, z, 0, { strictlySimple: false });
                feng = fe;
            }
            if (modelAnchor) {
                // phantom-sliver forgiveness: un-cleared cells within one
                // grid cell of the verified void are the quantization class
                // the coverage net forgives via `vquiet` — material there
                // is not a reason to emit a fragment. the matrix-domain
                // edge band (`edgeQuiet`) is the same class at the grid
                // boundary. the raw matrix stays the engagement source
                // (mat is untouched), so nothing real gets silently
                // excused here
                let fe = [];
                POLY.subtract(feng, vquiet, fe, undefined, z, 0, { strictlySimple: false });
                if (aquiet.length && fe.length) {
                    let fe2 = [];
                    POLY.subtract(fe, aquiet, fe2, undefined, z, 0, { strictlySimple: false });
                    fe = fe2;
                }
                if (edgeQuiet.length && fe.length) {
                    let fe2 = [];
                    POLY.subtract(fe, edgeQuiet, fe2, undefined, z, 0, { strictlySimple: false });
                    fe = fe2;
                }
                feng = fe;
            }
            let fA = feng.reduce((a, p) => a + p.areaDeep(), 0);
            if (typeof process !== 'undefined' && process.env.FARRCF &&
                Math.abs(cutz - parseFloat(process.env.FARRCZ || 30)) < 0.001) {
                let rmax = 0;
                for (const q of frag.points) rmax = Math.max(rmax, Math.hypot(q.x, q.y));
                console.log(`[FARRCF] k=${k} c=${c.toFixed(2)} src=${fragSrc[fi]} open=${!!frag.open} n=${frag.points.length} rmax=${rmax.toFixed(1)} p0=(${frag.points[0].x.toFixed(1)},${frag.points[0].y.toFixed(1)}) engA=${fA.toFixed(3)}`);
                if (process.env.FARRCE && fA > 0 && fA < parseFloat(process.env.FARRCEMAX || 15)) {
                    for (const e of feng) {
                        console.log(`[FARRCE] k=${k} c=${c.toFixed(2)} src=${fragSrc[fi]} A=${e.areaDeep().toFixed(3)} eng poly n=${e.points.length} open=${!!e.open}: ` +
                            e.points.map(q => `(${q.x.toFixed(2)},${q.y.toFixed(2)})`).join(' '));
                    }
                }
            }
            if (fA < minEng) {
                continue;
            }
            kept.push(frag);
            keptSrc.push(fragSrc[fi]);
            keptRaw.appendAll(fh);
            fresh.appendAll(feng);
        }
        if (!kept.length) {
            // each anchor boundary's fresh band sweeps monotonically with
            // c, so once no fragment of this offset touches real material,
            // no later offset can do better anywhere (each boundary
            // segment's band has already crossed all remaining material or
            // left the safe zone). any residual uncovered band near the
            // wall is finished by the wall ring(s) and validated by the
            // coverage net below
            break;
        }
        if (typeof process !== 'undefined' && process.env.FARRC &&
            Math.abs(cutz - parseFloat(process.env.FARRCZ || 30)) < 0.001) {
            const engA = fresh.reduce((a, p) => a + p.areaDeep(), 0);
            const srcs = {};
            for (const s of keptSrc) srcs[s] = (srcs[s] || 0) + 1;
            console.log(`[FARRC] k=${k} c=${c.toFixed(2)} raw=${raw.length} frags=${frags.length} kept=${kept.length} src=${JSON.stringify(srcs)} engA=${engA.toFixed(3)} pts=${kept.reduce((a, f) => a + f.points.length, 0)}`);
        }
        // record the full sweep over material (not just the fresh part):
        // later rings must not re-count material this ring already removes
        removed = removed.length ?
            POLY.union([ ...removed, ...keptRaw ], 0.00001, true) :
            POLY.union(keptRaw, 0.00001, true);
        rings.appendAll(kept);
    }
    if (!rings.length) {
        { console.log(`[FARRX] z=${z} exit: rings empty`); return undefined; }
    }

    // wall-anchored finishing ring(s). anchored on the shadow dilated by
    // R + leave in axis space — the exact boundary of the forbidden axis
    // zone — instead of the legacy offset(clip, -(R + L)) contour. the
    // legacy anchor degenerates (collapses and gets dropped) wherever the
    // local material width is <= 2 * (R + L) — a narrow shelf left
    // un-aligned at its closed edge (see #703ee573: 8mm shelf, Ø8 tool,
    // L=0). the shadow-dilated contour exists for any geometry, its tool
    // disk reaches to within L of the wall. the ring must NOT be clipped
    // by `safe`: the safe boundary sits a ts_eps deeper than the ring
    // contour (both are offsets of the same shadow), so clipping on the
    // coinciding edges kills the whole ring. the ring leaves L at the
    // wall by construction, so the working zone of the axis is the op
    // clip itself (`clipBase`), not `reach`: clipping on `reach` (clip
    // dilated by R) leaves the ring untouched wherever the shadow sits
    // near the clip boundary, letting the disk sweep up to R beyond the
    // op's working area (see #2a1a05fa follow-up: rough inside-only
    // flats aligned outside the part). inside the clip, the ring sits
    // R + L off the wall contour, so the clip edge cannot coincide with
    // it and the ts_eps kill does not apply; segments beyond the clip
    // (outer walls, outside-only rough) are trimmed into nothing, and if
    // the coverage net then fails, the caller falls back to the legacy
    // rings — conservative, as before the free-anchor feature
    let wall = [];
    for (let w of POLY.offset(shadow, [ R + L ], { count: 1, flat: true, z, ...offopt }) ?? []) {
        let cut = w.cut(clipBase, true);
        // rejoin the pixel-diced fragments of this contour into whole
        // finish chains (see stitchWallFrags) before the engagement
        // filter and emission: fewer, longer wall passes
        if (cut) wall.appendAll(stitchWallFrags(cut, modelAnchor ? ts_eps : tol));
    }
    if (finishCut) {
        // legacy finish_cut pass sits finishCut deeper into the material
        // than the wall ring; same anchor, dilated accordingly
        for (let w of POLY.offset(shadow, [ R + L + finishCut ], { count: 1, flat: true, z, ...offopt }) ?? []) {
            let cut = w.cut(clipBase, true);
            if (cut) wall.appendAll(stitchWallFrags(cut, modelAnchor ? ts_eps : tol));
        }
    }
    if (modelAnchor && wall.length) {
        // on model-anchor planes, drop wall fragments whose sweep touches
        // no real (non-sliver) material: the shadow dilation's outer
        // contour rides the matrix-verified void band outside the part
        // silhouette and otherwise emits as sliver-cutting junk (measured
        // 12-28 fragments beyond the silhouette on the reference ledge
        // plane). wall fragments are deliberately NOT filtered against
        // `removed`: finish passes legitimately re-trace already-swept
        // wall bands
        let wkept = [];
        for (let w of wall) {
            let real = false;
            for (let sw of sweepOf(w)) {
                let fh = [];
                for (let m of mat) {
                    let hit = sw.mask(m);
                    if (hit) fh.appendAll(hit);
                }
                if (!fh.length) {
                    continue;
                }
                let fe = [];
                POLY.subtract(fh, vquiet, fe, undefined, z, 0, { strictlySimple: false });
                if (aquiet.length && fe.length) {
                    let fe2 = [];
                    POLY.subtract(fe, aquiet, fe2, undefined, z, 0, { strictlySimple: false });
                    fe = fe2;
                }
                if (edgeQuiet.length && fe.length) {
                    let fe2 = [];
                    POLY.subtract(fe, edgeQuiet, fe2, undefined, z, 0, { strictlySimple: false });
                    fe = fe2;
                }
                if (fe.reduce((a, p) => a + p.areaDeep(), 0) >= minEng) {
                    real = true;
                    break;
                }
            }
            if (real) {
                wkept.push(w);
            }
        }
        wall = wkept;
    }

    // coverage net: the family plus wall rings must leave no significant
    // material behind over the accounting domain `dom` (the legacy
    // progression always covers the clip); otherwise defer to the legacy
    // rings. union before subtract (even-odd overlap hazard, see
    // engagement comment above)
    let cov = [];
    for (let w of wall) {
        for (let sw of sweepOf(w)) {
            for (let m of dom) {
                let hit = sw.mask(m);
                if (hit) cov.appendAll(hit);
            }
        }
    }
    cov.appendAll(removed);
    cov = POLY.union(cov, 0.00001, true);
    let uncut = [];
    POLY.subtract(dom, cov, uncut, undefined, z, 0);
    // material within L of the shadow is the intentional leave shell —
    // neither the generated set nor the legacy progression may touch it —
    // so only uncut material outside that zone counts against coverage.
    // `forb` (the axis-space shadow ⊕ R + L zone) must NOT be used here:
    // it is the tool-axis no-go band, whose material footprint reaches
    // R + L into the clip, so forgiving uncut material across all of it
    // would silently accept a wall band up to R wide left un-machined.
    // the true leave shell is shadow ⊕ L in material space; anything
    // outside it must be covered by the family or the wall ring(s)
    let leave = POLY.offset(shadow, [ L + ts_eps ], { count: 1, flat: true, z, ...offopt, minArea: 0.01 }) ?? [];
    if (leave.length) {
        let bad = [];
        POLY.subtract(uncut, leave, bad, undefined, z, 0);
        uncut = bad;
    }
    // wall-straddling cell rows (model-anchor planes): matrix cells
    // straddling the model-true shadow contour never pass the 4-corner
    // cleared test, so `mat` carries phantom material up to one grid cell
    // BEYOND the contour. that band is out of reach of every forgiveness
    // zone anchored on the pixel void (`vquiet`/`aquiet` end at the
    // contour: the void boundary itself sits up to a cell short of it)
    // and of the wall ring's sweep (model-true, reaching exactly the
    // contour) — measured on the reference cavity floor plane: 78
    // fragments, 2.35 mm^2 hugging the cavity wall, rejecting the whole
    // generated set and rolling the plane back to the legacy pixel rings.
    // no model material rises above the cut plane beyond the shadow
    // contour, so the band holds only quantization phantoms; real floor
    // material inside the band (below the plane) is covered by the wall
    // ring, whose sweep reaches the contour. forgive it like the other
    // quantization classes — anything wider or deeper still fails
    if (modelAnchor) {
        let wquiet = POLY.offset(shadow, [ stockModel.resolution + ts_eps ], {
            count: 1, flat: true, z, join: clib.JoinType.jtRound, arc: 250, minArea: 0.01
        }) ?? [];
        if (wquiet.length && uncut.length) {
            let bad = [];
            POLY.subtract(uncut, wquiet, bad, undefined, z, 0);
            uncut = bad;
        }
    }
    // the stock model's cleared test is per-cell (all 4 corner nodes at or
    // below the plane), so cells straddling a cleared/material boundary
    // never verify as cleared and `mat` carries a phantom sliver up to one
    // grid cell wide along every free edge. along the part outline no
    // legal tool axis exists (wall standoff), so that sliver is not
    // machinable by the generated set -- yet it is indistinguishable from
    // the cut side of the same quantization boundary. forgive uncut
    // material within one grid cell of the verified void (the raw matrix
    // union when the model anchor holds — its boundary sits within one
    // cell of the anchor anyway); anything wider or deeper still fails
    // the net and defers to the legacy rings. `vquiet` was computed above
    // (it doubles as the domain adjacency probe)
    if (vquiet.length) {
        let bad = [];
        POLY.subtract(uncut, vquiet, bad, undefined, z, 0);
        uncut = bad;
    }
    // the anchor-based zone is the same quantization class one cell deeper:
    // wall-straddling cell rows at concave silhouette stretches sit past
    // the void-based reach, no legal axis exists within R of the shadow
    // there, and the family bands cover them only where a ring ran. with
    // sweeps now honest (true annuli above), these rows would otherwise
    // fail the net and roll the whole plane back to the legacy rings
    if (aquiet.length && uncut.length) {
        let bad = [];
        POLY.subtract(uncut, aquiet, bad, undefined, z, 0);
        uncut = bad;
    }
    // the domain-edge band is the same quantization class at the grid
    // boundary (see edgeQuiet above); forgive it in the net as well
    if (edgeQuiet.length && uncut.length) {
        let bad = [];
        POLY.subtract(uncut, edgeQuiet, bad, undefined, z, 0);
        uncut = bad;
    }
    let uncutA = uncut.reduce((a, p) => a + p.areaDeep(), 0);
    if (uncutA > (typeof process !== 'undefined' && process.env && process.env.FARRT ? parseFloat(process.env.FARRT) : S * S * 0.25)) {
        if (typeof process !== 'undefined' && process.env && process.env.FARRX) {
            for (const u of uncut) {
                let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
                for (const q of u.points) { x0=Math.min(x0,q.x); x1=Math.max(x1,q.x); y0=Math.min(y0,q.y); y1=Math.max(y1,q.y); }
                console.log(`[FARRXU] z=${z} A=${u.areaDeep().toFixed(3)} open=${!!u.open} n=${u.points.length} bb=x[${x0.toFixed(2)},${x1.toFixed(2)}] y[${y0.toFixed(2)},${y1.toFixed(2)}] pts=${u.points.slice(0,20).map(q=>`(${q.x.toFixed(2)},${q.y.toFixed(2)})`).join(' ')}`);
            }
        }
        { console.log(`[FARRX] z=${z} exit: net fail uncutA=${uncutA}`); return undefined; }
    }

    if (globalThis.__FARR ?? (typeof process !== 'undefined' ? process.env.FARR : undefined)) {
        const desc = p => {
            let n = p.points.length, len = 0;
            for (let i = 1; i < n; i++) {
                const dx = p.points[i].x - p.points[i-1].x, dy = p.points[i].y - p.points[i-1].y;
                len += Math.sqrt(dx * dx + dy * dy);
            }
            const q = p.points[0];
            let s = `${p.open ? "open" : "clos"} n=${n} len=${len.toFixed(1)} p0=(${q.x.toFixed(2)},${q.y.toFixed(2)})`;
            for (const inn of (p.inner ?? [])) {
                let ni = inn.points.length, li = 0;
                for (let i = 1; i < ni; i++) {
                    li += Math.hypot(inn.points[i].x - inn.points[i-1].x, inn.points[i].y - inn.points[i-1].y);
                }
                s += ` | inner n=${ni} len=${li.toFixed(1)} p0=(${inn.points[0].x.toFixed(2)},${inn.points[0].y.toFixed(2)})`;
            }
            return s;
        };
        console.log(`[FARR] z=${z} family:\n  ${rings.map((r, i) => `${desc(r)} src=${keptSrc[i] ?? 'W'}`).join("\n  ")}`);
        console.log(`[FARR] z=${z} wall:\n  ${wall.map(desc).join("\n  ")}`);
    }

    if (typeof process !== 'undefined' && process.env.FARRW &&
        Math.abs(cutz - parseFloat(process.env.FARRWZ || 27.5)) < 0.001) {
        const rt = ps => ps.map(q => `(${q.x.toFixed(2)},${q.y.toFixed(2)})`).join(' ');
        for (const w of wall) {
            console.log(`[FARRW] open=${!!w.open} outer: ${rt(w.points)}`);
            for (const inn of (w.inner ?? [])) console.log(`[FARRW]   inner: ${rt(inn.points)}`);
        }
        if (process.env.FARRWF) {
            rings.forEach((r, i) => {
                if ((process.env.FARRWF === 'M') !== (keptSrc[i] === 'M')) return;
                console.log(`[FARRW] family[${i}] src=${keptSrc[i]} open=${!!r.open} n=${r.points.length}: ${rt(r.points)}`);
                for (const inn of (r.inner ?? [])) console.log(`[FARRW] family[${i}]   inner: ${rt(inn.points)}`);
            });
        }
    }

    let out = stampFarrSeq([ ...rings, ...wall ]);
    // e2e harness channel (bin/cam-bench): the stamped authored-order set,
    // so acceptance can match emitted paths back to their rings and verify
    // the emitter respected the order (task #03afbbf1). gated off in the
    // browser; the harness sets globalThis.__FARRJ before loading the worker
    if (globalThis.__FARRJ) {
        console.log('[FARRJ] ' + JSON.stringify({
            z, cutz,
            set: out.map((p, i) => ({
                s: p.farrSeq, o: p.open ? 1 : 0,
                // path source: family ring (M = model-true / P = pixel anchor)
                // or wall finish piece (W) — lets acceptance verify that the
                // whole family block precedes the wall finish block
                w: i < rings.length ? (keptSrc[i] ?? 'M') : 'W',
                pts: p.points.map(q => [ +q.x.toFixed(2), +q.y.toFixed(2) ])
            }))
        }));
    }
    return out;
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
