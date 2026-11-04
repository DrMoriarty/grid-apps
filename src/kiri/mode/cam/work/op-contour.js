/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { CamOp } from '../core/op.js';
import { Tool } from '../core/tool.js';
import { generate as Topo } from './topo3.js';
import { newPoint } from '../../../../geo/point.js';
import { newPolygon } from '../../../../geo/polygon.js';
import { newSlice } from '../../../core/slice.js';
import { tip2tipEmit } from '../../../../geo/paths.js';

function createFilter(op, origin, axis) {
    // console.log({ origin, axis });
    let ok = () => true;
    let filter = slices => slices;
    let filterString = op.filter?.map(l => l.trim()).join('\n');
    if (filterString) {
        try {
            const obj = eval(`( ${filterString} )`);
            let box = obj?.box;
            let slice_fn = obj?.slices;
            let index = 0;
            const accept = [];
            filter = function (slices) {
                for (let slice of slices.filter(s => s.camLines)) {
                    if (slice_fn && slice_fn(slice, index++)) {
                        accept.push(slice);
                    } else if (box) {
                        // slice.z = x when axis = y
                        // slice.z = y when axis = x
                        let { x, y, z } = box;
                        x = x ?? [ -Infinity, Infinity ];
                        y = y ?? [ -Infinity, Infinity ];
                        z = z ?? [ -Infinity, Infinity ];
                        // merged ops carry both orientations in one op:
                        // rows (mergedDir 'x') test the y box, columns
                        // (mergedDir 'y') test the x box
                        const effAxis = axis === 'merged'
                            ? (slice.mergedDir === 'x' ? 'x' : 'y')
                            : axis;
                        let ok = false;
                        if (effAxis === 'x') {
                            let sy = slice.z + origin.y;
                            if (sy >= y[0] && sy <= y[1]) {
                                ok = true;
                                for (let p of slice.camLines) {
                                    p.points = p.points.filter(p =>
                                        p.x - origin.x >= x[0] && p.x - origin.x <= x[1] &&
                                        p.z - origin.z >= z[0] && p.z - origin.z <= z[1]
                                    );
                                }
                            }
                        } else {
                            let sx = slice.z - origin.x;
                            if (sx >= x[0] && sx <= x[1]) {
                                ok = true;
                                for (let p of slice.camLines) {
                                    p.points = p.points.filter(p =>
                                        p.y + origin.y >= y[0] && p.y + origin.y <= y[1] &&
                                        p.z - origin.z >= z[0] && p.z - origin.z <= z[1]
                                    );
                                }
                            }
                        }
                        if (ok) {
                            slice.camLines = slice.camLines.map(p => {
                                if (p.points.length > 1) {
                                    return newPolygon(p.points).setOpen(true);
                                } else {
                                    return undefined;
                                }
                            }).filter(p => p);
                            accept.push(slice);
                        }
                    }
                }
                return accept;
            };
        } catch (e) {
            console.log('filter parse error', e, op.filter);
        }
    }
    return filter;
}

/**
 * Split open polylines wherever point z exceeds zmax, interpolating
 * crossing points at exactly zmax and dropping the portions above.
 * Used to apply a per-op Z Top limit to contour terrain-following paths.
 */
function clipPolysToZMax(polys, zmax) {
    const out = [];
    for (let poly of polys) {
        const pts = poly.points;
        let cur = null;
        const flush = () => {
            if (cur && cur.length > 1) {
                out.push(cur);
            }
            cur = null;
        };
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (p.z > zmax) {
                if (cur) {
                    // ascending crossing: end segment at zmax
                    const a = cur.last();
                    const t = (zmax - a.z) / (p.z - a.z);
                    cur.push(newPoint(
                        a.x + (p.x - a.x) * t,
                        a.y + (p.y - a.y) * t,
                        zmax
                    ));
                    flush();
                }
            } else {
                if (!cur) {
                    cur = newPolygon().setOpen();
                    if (i > 0 && pts[i-1].z > zmax) {
                        // descending crossing: start segment at zmax
                        const a = pts[i-1];
                        const t = (zmax - a.z) / (p.z - a.z);
                        cur.push(newPoint(
                            a.x + (p.x - a.x) * t,
                            a.y + (p.y - a.y) * t,
                            zmax
                        ));
                    }
                }
                cur.push(p);
            }
        }
        flush();
    }
    return out;
}

class OpContour extends CamOp {
    constructor(state, op) {
        super(state, op);
    }

    async slice(progress) {
        let { op, state } = this;
        let { color, addSlices, settings, updateToolDiams } = state;

        let conTool = new Tool(settings, op.tool);
        let filter = createFilter(op, settings.origin, op.axis.toLowerCase());
        let toolDiam = this.toolDiam = conTool.fluteDiameter();
        this.toolStep = conTool.getStepSize(op.step);

        updateToolDiams(toolDiam);

        // we need topo for safe travel moves when roughing and outlining
        // not generated when drilling-only. then all z moves use bounds max.
        // also generates x and y contouring when selected
        let topo = this.topo = await Topo({
            // onupdate: (update, msg) => {
            onupdate: (index, total, msg) => {
                progress(index / total, msg);
            },
            ondone: (slices) => {
                // apply per-op Z Top limit: split camLines where z exceeds
                // top_z (post-processing keeps topo raster/contour untouched)
                if (op.ov_topz) {
                    let zTopClamp = state.workarea.top_z;
                    for (let slice of slices) {
                        if (slice.camLines) {
                            slice.camLines = clipPolysToZMax(slice.camLines, zTopClamp);
                        }
                    }
                }
                slices = filter(slices);
                this.sliceOut = slices;
                addSlices(slices);
                for (let slice of slices) {
                    slice.output()
                        .setLayer(`contour ${op.axis}`, { face: color, line: color })
                        .addPolys(slice.camLines);
                }
            },
            contour: op,
            state
        });

        if (this.debug && topo.coastline) {
            console.log('coastline', topo.coastline);
            const dbs = newSlice(-1);
            const dbo = dbs.output();
            dbo.setLayer("coastline", { line: 0x0000dd }).addPolys(topo.coastline);
            addSlices([ dbs ])
        }

        // computed if set to 0
        this.tolerance = topo.tolerance;
    }

    prepare(ops, progress) {
        let { op, sliceOut, state, toolStep, topo } = this;
        let { settings } = state;
        let { process } = settings;

        let { polyEmit, setContouring, setTolerance, setTool } = ops;
        let { widget, newLayer, zmax } = ops;

        let bounds = widget.getBoundingBox();
        let depthData = [];

        setTool(op.tool, op.rate, process.camFastFeedZ);
        setContouring(true, toolStep * 1.5, topo.coastline);
        setTolerance(this.tolerance);

        let printPoint = newPoint(bounds.min.x, bounds.min.y, zmax);

        for (let slice of sliceOut) {
            // ignore debug slices
            if (!slice.camLines) {
                continue;
            }
            let polys = [], poly;
            slice.camLines.forEach((poly) => {
                poly = poly.clone(true).annotate({ slice: slice.index + 1 });
                polys.push({ first: poly.first(), last: poly.last(), poly: poly });
            });
            depthData.appendAll(polys);
        }

        tip2tipEmit(depthData, printPoint, (el, point) => {
            let poly = el.poly;
            if (poly.last() === point) {
                poly.reverse();
            }
            polyEmit(poly);
            newLayer();
        });
    }
}

export { OpContour };