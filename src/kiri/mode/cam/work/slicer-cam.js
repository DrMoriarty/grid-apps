/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { util } from '../../../../geo/base.js';
import { decode, decodePointArray } from '../../../core/codec.js';
import { newLine } from '../../../../geo/line.js';
import { newPoint } from '../../../../geo/point.js';
import { newSlice } from '../../../core/slice.js';
import { polygons as POLY } from '../../../../geo/polygons.js';
import {
    checkOverUnderOn,
    intersectPoints,
    makeZLine,
    removeDuplicateLines,
    sliceConnect,
} from '../../../../geo/slicer.js';

const timing = false;
const zDecimal = 3;
const epsilon = 10e-5;

const begin = function () {
    if (timing) console.time(...arguments);
};

const end = function () {
    if (timing) console.timeEnd(...arguments);
};

export class Slicer {
    constructor(widget, options = { zlist: true, zline: true, lines: false }) {
        this.minions = self.kiri_worker?.minions;
        this.widget = widget;
        this.options = {};
        this.setOptions(options);

        if (widget) {
            this.threaded = this.minions && this.minions.running;
            this.setPoints(widget.getGeoVertices({ unroll: true, translate: true }));
            // reuse feature stats cached on the widget when the vertex
            // buffer is unchanged (slicers are created many times over
            // the same widget during a single CAM slicing run)
            if (!this.restoreFeatures()) {
                this.computeFeatures();
            }
        }
    }

    // zList = generate list of z vertices
    // zline = generate list of z vertices with coplanar lines
    // trace = find z coplanar trace lines
    // flatoff = amount to offset z when slicing on detected flats
    // each = call for each slice generated from an interval
    setOptions(options) {
        Object.assign(this.options, options || {});
        return this.options;
    }

    setPoints(points) {
        this.bounds = null;
        this.points = points;
        this.zFlat = {}; // accumulated flat area at z height
        this.zLine = {}; // count of z coplanar lines
        this.zList = {}; // count of z values for auto slicing
        return this;
    }

    // restore previously computed feature stats from the widget cache.
    // valid only when the vertex buffer is unchanged (identity check on
    // the points array: any geometry / axis rotation change produces a
    // new array from getGeoVertices). returns true when restored.
    restoreFeatures() {
        const widget = this.widget;
        if (!widget) {
            return false;
        }
        const cached = widget.cache.slicer_features;
        if (!cached || cached.points !== this.points) {
            return false;
        }
        this.bounds = cached.bounds;
        this.zList = cached.zList;
        this.zLine = cached.zLine;
        this.zFlatAll = cached.zFlatAll;
        this.zFlatUp = cached.zFlatUp;
        this.zFlat = this.options.zflatup ? this.zFlatUp : this.zFlatAll;
        return true;
    }

    // gather z-index stats
    // these are used for auto-slicing in laser
    // and to flats detection in CAM mode
    computeFeatures(options) {
        begin('compute features');

        const opt = this.setOptions(options);
        const bounds = this.bounds = new THREE.Box3();
        const points = this.points;
        const zFlat = this.zFlat = {};     // accumulated flat area at z height
        const zFlatUp = this.zFlatUp = {}; // accumulated up-facing flat area
        const zLine = this.zLine = {};     // count of z coplanar lines
        const zList = this.zList = {};     // count of z values for auto slicing

        function countZ(z) {
            z = z.round(zDecimal);
            zList[z] = (zList[z] || 0) + 1;
        }

        // normal z of a face, identical to THREE.computeFaceNormal(a,b,c).z
        // but without allocations in the hot loop. used to filter
        // up-facing flats for the zflatup option
        function faceNormalZ(p1, p2, p3) {
            const ux = p3.x - p2.x, uy = p3.y - p2.y, uz = p3.z - p2.z;
            const vx = p1.x - p2.x, vy = p1.y - p2.y, vz = p1.z - p2.z;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            let nz = ux * vy - uy * vx;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            return nz / nl;
        }

        let p1 = newPoint(0, 0, 0),
            p2 = newPoint(0, 0, 0),
            p3 = newPoint(0, 0, 0);

        // for (let i = 0, il = points.length; i < il; i++) {
        //     points[i] = points[i].round(zDecimal);
        // }

        for (let i = 0, il = points.length; i < il;) {
            p1.set(points[i++], points[i++], points[i++]);
            p2.set(points[i++], points[i++], points[i++]);
            p3.set(points[i++], points[i++], points[i++]);
            // update bounds
            bounds.expandByPoint(p1);
            bounds.expandByPoint(p2);
            bounds.expandByPoint(p3);
            // count occurrences of z values for auto slicing
            if (opt.zlist) {
                countZ(p1.z);
                countZ(p2.z);
                countZ(p3.z);
            }
            // use co-flat and co-line detection to adjust slice Z
            if (Math.abs(p1.z - p2.z) < epsilon && Math.abs(p2.z - p3.z) < epsilon) {
                // detect zFlat faces to avoid slicing directly on them.
                // compute both flat variants in one pass so the widget
                // cache can serve slicers with either zflatup setting
                let zkey = p1.z.toFixed(zDecimal),
                    area = Math.abs(util.area2(p1, p2, p3)) / 2;
                zFlat[zkey] = (zFlat[zkey] || 0) + area;
                // filter to up-facing flats (more expensive)
                if (faceNormalZ(p1, p2, p3) >= -0.00001) {
                    zFlatUp[zkey] = (zFlatUp[zkey] || 0) + area;
                }
            } else if (opt.zline) {
                // detect zLine (curved region tops/bottoms)
                // in cam used for ball and v mill tracing
                if (p1.z === p2.z) {
                    let zkey = p1.z.toFixed(zDecimal);
                    let zval = zLine[zkey];
                    zLine[zkey] = (zval || 0) + 1;
                }
                if (p2.z === p3.z) {
                    let zkey = p2.z.toFixed(zDecimal);
                    let zval = zLine[zkey];
                    zLine[zkey] = (zval || 0) + 1;
                }
                if (p3.z === p1.z) {
                    let zkey = p3.z.toFixed(zDecimal);
                    let zval = zLine[zkey];
                    zLine[zkey] = (zval || 0) + 1;
                }
            }
        }

        // zFlat honors the zflatup option: up-facing flats only when set
        this.zFlat = opt.zflatup ? zFlatUp : zFlat;

        end('compute features');

        // cache features on the widget for reuse by subsequent slicers.
        // only cache complete stats (zlist and zline both enabled) so a
        // slicer created with partial options cannot seed a partial cache
        if (this.widget && opt.zlist && opt.zline) {
            this.widget.cache.slicer_features = {
                points,
                bounds,
                zList,
                zLine,
                zFlatAll: zFlat,
                zFlatUp
            };
        }

        // console.log({ bounds, zFlat, zLine, zList });

        return this;
    }

    /**
     * Given an array of z-slice positions, generate a list of polygons
     * representing the intersection of the mesh with the given z-slice
     * positions.
     *
     * @param {number[]} zs - array of z-slice positions
     * @param {Object} options - slicing parameters
     * @param {number} [options.flatoff=0.01] - z offset when slicing on a flat surface
     * @param {boolean} [options.progress=false] - callback with slice progress
     * @param {function} [options.each] - callback with each slice result
     * @returns {Promise<Object[]>} - list of slice objects with z and tops (polygons)
     */
    async slice(zs, options) {
        const opt = this.setOptions(options);
        // slice through points at given Z and return polygons

        if (!Array.isArray(zs)) {
            throw "slice zs parameter must be ab array";
        }

        // sort Z and offset when on a flat
        const flatoff = util.numOrDefault(opt.flatoff, 0.01);
        zs = zs.sort((a, b) => a - b).map(z => {
            if (!flatoff) {
                return z;
            }
            const znorm = z.toFixed(zDecimal);
            return this.zFlat[znorm] ? z + flatoff : z;
        });

        // compute buckets from z slice list
        const { points } = this;
        const plen = points.length;
        const zlen = zs.length;
        const ppz = plen / zlen;
        const count = 25;//Math.ceil(ppz / 10000);
        const step = Math.ceil(zlen / count);
        const buckets = [];

        // console.log({ points, zs, count, step });

        for (let c = 0, b = 0; c < count; c++) {
            if (b >= zlen) break;
            buckets.push({
                zs: zs.slice(b, b + step),
                index: []
            });
            b += step;
        }

        // precompute z bounds for each bucket once (avoids O(tris * zlen)
        // Math.min/max spread calls in the hot triangle loop below)
        for (let bucket of buckets) {
            const bzs = bucket.zs;
            let bmin = bzs[0], bmax = bzs[0];
            for (let i = 1; i < bzs.length; i++) {
                const z = bzs[i];
                if (z < bmin) bmin = z;
                if (z > bmax) bmax = z;
            }
            bucket.zmin = bmin;
            bucket.zmax = bmax;
        }

        let p1 = newPoint(0, 0, 0),
            p2 = newPoint(0, 0, 0),
            p3 = newPoint(0, 0, 0),
            ep = 0.001;

        begin("create buckets");
        for (let i = 0, il = points.length; i < il;) {
            p1.set(points[i++], points[i++], points[i++]);
            p2.set(points[i++], points[i++], points[i++]);
            p3.set(points[i++], points[i++], points[i++]);
            let zmin = Math.min(p1.z, p2.z, p3.z);
            let zmax = Math.max(p1.z, p2.z, p3.z);
            for (let bucket of buckets) {
                const { index } = bucket;
                const min = bucket.zmin;
                const max = bucket.zmax;
                if (zmin < min && zmax < min) {
                    if (Math.abs(zmin - min) > ep && Math.abs(zmax - min) > ep) {
                        continue;
                    }
                }
                if (zmin > max && zmax > max) {
                    if (Math.abs(zmin - max) > ep && Math.abs(zmax - max) > ep) {
                        continue;
                    }
                }
                index.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
            }
        }
        end("create buckets");

        // console.log({ zs, zlen, count, step, buckets, flatoff });

        begin("slicing");
        const { minions } = this;
        const threaded = minions && minions.running;
        const sliceFn = (threaded ? this.sliceBucketMinion : this.sliceBucket).bind(this);
        const track = { count: 0, total: zs.length };

        if (threaded) minions.broadcast("cam_slice_init", {});

        const promises = []
        for (let bucket of buckets) {
            promises.push(sliceFn(bucket, { ...opt, minZ: this.bounds.min.z }, slice => {
                track.count++;
                if (opt.progress) {
                    opt.progress(track.count, track.total);
                }
                // console.log({ oneach: slice, ...track });
            }));
        }

        const data = (await Promise.all(promises)).flat();
        data.sort((a, b) => b.z - a.z);

        for (let i=0; i<data.length; i++) {
            let rec = data[i];
            rec.tops = rec.polys;
            rec.slice = newSlice(rec.z).addTops(rec.tops);
            if (opt.each) {
                await opt.each(rec, i, data.length);
            }
        }

        if (threaded) minions.broadcast("cam_slice_cleanup");
        end("slicing");

        return data;
    }

    async sliceBucketMinion(bucket, opt, oneach) {
        const slices = (await new Promise(resolve => {
            this.minions.queue({
                cmd: "cam_slice",
                opt: Object.clone(opt),
                bucket,
            }, resolve);
        })).slices;
        for (let slice of slices) {
            slice.polys = decode(slice.polys);
            if (slice.lines) {
                slice.lines = decodePointArray(slice.lines)
                    .group(2)
                    .map(arr => {
                        return newLine(arr[0], arr[1])
                    });
            }
            oneach(slice);
        }
        // console.log(bucket, slices);
        return slices;
    }

    async sliceBucket(bucket, opt, oneach) {
        const { zs, index } = bucket;
        const slices = [];
        for (let z of zs) {
            const slice = this.sliceZ(z, index, opt);
            if (slice) {
                slices.push(slice);
            }
            oneach(slice);
        }
        return slices;
    }

    sliceZ(z, indices, opt) {
        let links = opt.links !== false,
            dedup = opt.dedup !== false,
            edges = opt.edges || false,
            over = opt.over || z <= opt.minZ,
            debug = opt.debug,
            phash = {},
            lines = [];

        // const { points } = this,
        const points = indices,
            p1 = newPoint(0, 0, 0),
            p2 = newPoint(0, 0, 0),
            p3 = newPoint(0, 0, 0);

        for (let index = 0; index < points.length;) {
            p1.set(points[index++], points[index++], points[index++]);
            p2.set(points[index++], points[index++], points[index++]);
            p3.set(points[index++], points[index++], points[index++]);

            let where = { under: [], over: [], on: [] };
            checkOverUnderOn(p1, z, where);
            checkOverUnderOn(p2, z, where);
            checkOverUnderOn(p3, z, where);
            if (where.under.length === 3 || where.over.length === 3) {
                // does not intersect (all 3 above or below)
            } else if (where.on.length === 2) {
                // one side of triangle is on the Z plane and 3rd is below
                // drop lines with 3rd above because that leads to ambiguities
                // with complex nested polygons on flat surface
                if ((over && where.over.length === 1) || (!over && where.under.length === 1)) {
                    lines.push(makeZLine(phash, where.on[0], where.on[1], false, true));
                }
            } else if (where.on.length === 3) {
                // triangle is coplanar with Z
                // we drop these because this face is attached to 3 others
                // that will satisfy the if above (line) with 2 points
            } else if (where.under.length === 0 || where.over.length === 0) {
                // does not intersect but one point is on the slice Z plane
            } else if (!edges) {
                // compute two point intersections and construct line
                let line = intersectPoints(where.over, where.under, z);
                if (line.length < 2 && where.on.length === 1) {
                    line.push(where.on[0].clone());
                }
                if (line.length === 2) {
                    lines.push(makeZLine(phash, line[0], line[1]));
                } else {
                    console.log({ msg: "invalid ips", line: line, where: where });
                }
            }
        }

        if (dedup) {
            // console.log({ z, dedup: lines, points });
            lines = removeDuplicateLines(lines, debug);
        }

        return lines.length ? {
            z,
            lines: opt.lines !== false ? lines : undefined,
            polys: links ? POLY.nest(sliceConnect(lines, opt, debug)) : undefined
        } : null;
    }

    interval(step, options) {
        let opt = options || {},
            bounds = this.bounds,
            boff = opt.boff || opt.off || 0, // bottom offset
            toff = opt.toff || opt.off || 0, // top offset
            zmin = opt.min !== undefined ? opt.min : bounds.min.z + boff,
            zmax = (opt.max || bounds.max.z) - toff,
            steps = (zmax - zmin) / step,
            rem = steps % 1 != 0 ? 0 : 1,
            count = Math.floor(steps) + rem,
            array = [];

        if (opt.fit) {
            count++;
            step = (zmax - zmin) / count;
        }
        if (opt.down) {
            for (let i = 0; i < count; i++) {
                array.push(zmax);
                zmax -= step;
            }
        } else {
            for (let i = 0; i < count; i++) {
                array.push(zmin);
                zmin += step;
            }
        }

        if (opt.fit) {
            array.push(opt.down ? zmax : zmin);
        }

        if (opt.flats && opt.off) {
            let add = [];
            Object.keys(this.zFlat).forEach(z => {
                z = parseFloat(z);
                add.push(z + opt.off);
                if (z > zmin) {
                    add.push(z - opt.off);
                }
            });
            // add over and under all flats by 'off'
            array.appendAll(add).sort((a, b) => {
                return opt.down ? b - a : a - b;
            });
        }

        // filter duplicate values
        array = array.map(v => v.round(zDecimal)).filter((e, i, a) => i < 1 || a[i - 1] !== a[i]);

        // return array.map(v => Math.abs(parseFloat(v.toFixed(zDecimal))));
        return array.map(v => parseFloat(v.toFixed(zDecimal)));
    }
}
