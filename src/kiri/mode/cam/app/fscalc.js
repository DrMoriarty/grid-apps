/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

/**
 * Advisory feed/speed calculator for CAM (phase 1 of the cutting
 * velocity/depth estimator). Pure functions -- no UI, no settings
 * mutation. Results are RECOMMENDATIONS only: nothing here is ever
 * silently applied to process settings by the caller.
 *
 * Core formula:  Vf = spindle_rpm × flutes × fz
 *
 * fz is estimated from the tool diameter with a linear model
 * (fz ≈ k × D) calibrated from `docs/cam-fz-materials.md` -- a
 * reference compiled across three web verification sessions
 * (research tasks 97a294a7 and 6fdc0df6). Values marked [E] in that
 * document are catalog-scale estimates NOT re-verified on the web
 * (Amana, LMT Onsrud, Curbell/IAPD, Aalto, PreciseBits numeric
 * tables -- see its §7 checklist); when the handbook is updated,
 * refresh these numbers again in a separate change. Source markers
 * [E]/[W] are carried in the comments below.
 *
 * Model validity: the linear fz ≈ k×D approximation holds for
 * D ≈ 4..16-20mm. fz(D) is NONLINEAR below Ø4mm -- tool strength,
 * not chip volume, becomes the limit, so the diameter table in
 * handbook §1 is authoritative for Ø<4 (§2). Below ~3mm fz is
 * clamped to a fixed PER-MATERIAL band (`smallFz` in each record):
 * 0.01-0.02 mm/tooth for metals, 0.03-0.08 for wood/MDF/plastics --
 * lower values rub instead of cut and burn or melt non-metals.
 */

 // per-material cutting coefficients. k is mm/tooth per mm of tool
 // diameter (fz ≈ k × D, valid for D ≈ 4..16-20mm -- see header).
 // docPct is max depth of cut as a fraction of tool diameter
 // [conservative (finishing cap), aggressive (roughing)].
 // plungePct is plunge rate as a fraction of feed rate [lo, hi].
 // smallFz is the fixed fz band [lo, hi] for D < SMALL_DIAM_MM.
 // All values in mm. Source: docs/cam-fz-materials.md unless noted.
const MATERIALS = {
    // aluminum 5xxx/6xxx. [W, session 2] Carbide 3D community practice:
    // fz 0.025-0.076 mm/tooth at Ø3-6.35 → k ≈ 0.004-0.012 observed; a
    // clean hobby-vs-production split is NOT confirmed by sources, so
    // k 0.006-0.009 is a working desktop-class approximation (§6(3),
    // §7(5)). DOC 0.25-0.5×D matches Carbide 3D practice (~0.4×D on a
    // rigid desktop machine). 1-2 flutes on desktop machines.
    aluminum: {
        label: "aluminum",
        kLo: 0.006,
        kHi: 0.009,
        docPct: [0.25, 0.5],
        plungePct: [0.25, 0.33],
        smallFz: [0.01, 0.02],
        warnings: [
            "aluminum: chip welding / built-up edge without lubrication -- " +
                "use mist/wax/taplube and clear chips frequently",
            "aluminum: 1-2 flutes on desktop machines (single flute easiest); " +
                "keep chip load above ~0.025 mm/tooth or chips weld to the tool"
        ]
    },
    // [E] handbook §2: k 0.005-0.007; cuts easily, coolant optional.
    // Neutral rake geometry preferred -- aggressive positive rake can
    // grab the material (§4).
    brass: {
        label: "brass",
        kLo: 0.005,
        kHi: 0.007,
        docPct: [0.25, 1.0],
        plungePct: [0.25, 0.35],
        smallFz: [0.01, 0.02],
        warnings: [
            "brass: prefers neutral rake geometry and reduced fz -- " +
                "aggressive positive rake can grab the material; " +
                "coolant optional"
        ]
    },
    // [E] router-scale chip loads (§2, §6(1)): the old metal-cutting
    // k 0.009-0.011 was the draft's main error (fz 3-5x too low).
    // Janka-hardness scaling between species, ΔJanka ≤ 400 [W, session 2].
    hardwood: {
        label: "hardwood (oak, beech)",
        kLo: 0.025,
        kHi: 0.037,
        docPct: [0.5, 1.0],
        plungePct: [0.4, 0.5],
        smallFz: [0.03, 0.08],
        warnings: [
            "hardwood: chipping/tearout on figured sections -- reduce fz; " +
                "burning means feed is too low"
        ]
    },
    // [E] router-scale chip loads (§2, §6(1)). High DOC only with up-cut
    // chip evacuation; desktop machines often run below catalog fz --
    // start from the lower third of the range and ramp up by test (§1).
    softwood: {
        label: "softwood (pine)",
        kLo: 0.030,
        kHi: 0.050,
        docPct: [0.5, 1.5],
        plungePct: [0.4, 0.6],
        smallFz: [0.03, 0.08],
        warnings: [
            "softwood: fuzzing/tearout with dull tools; resin build-up -- " +
                "keep tools sharp and clean; high DOC only with up-cut bits"
        ]
    },
    // [E] router-scale chip loads (§2, §6(1)); split from plywood (§4).
    mdf: {
        label: "MDF",
        kLo: 0.027,
        kHi: 0.040,
        docPct: [0.5, 1.0],
        plungePct: [0.4, 0.5],
        smallFz: [0.03, 0.08],
        warnings: [
            "MDF: abrasive -- carbide only, expect fast tool wear; " +
                "fine toxic dust -- dust extraction required; " +
                "burns at low feed / high rpm"
        ]
    },
    // [E] split from MDF: adhesive layers are more abrasive, voids cause
    // feed shocks, so fz is lower than MDF (§2, §4).
    plywood: {
        label: "plywood (birch)",
        kLo: 0.020,
        kHi: 0.033,
        docPct: [0.5, 1.0],
        plungePct: [0.3, 0.5],
        smallFz: [0.03, 0.08],
        warnings: [
            "plywood: adhesive layers are abrasive; internal voids cause " +
                "feed shocks; up-cut tears the top veneer, down-cut chokes " +
                "chip evacuation -- compression bit for clean cuts both sides"
        ]
    },
    // [E] split from generic plastic (§2, §6(2)): POM machines
    // aggressively (fz 0.09-0.15 at Ø6).
    pom: {
        label: "POM (Delrin)",
        kLo: 0.015,
        kHi: 0.025,
        docPct: [0.25, 1.0],
        plungePct: [0.3, 0.5],
        smallFz: [0.03, 0.08],
        warnings: [
            "POM: machines easily; watch removal of long stringy chips"
        ]
    },
    // [E] split from generic plastic (§2, §6(2)): nylon is tough and
    // springy -- lower rpm / higher feed, sharp tools.
    pa: {
        label: "PA (nylon)",
        kLo: 0.013,
        kHi: 0.020,
        docPct: [0.25, 1.0],
        plungePct: [0.3, 0.5],
        smallFz: [0.03, 0.08],
        warnings: [
            "nylon (PA): tough and springy (elastic cuts) -- sharp tools, " +
                "lower rpm / higher feed; absorbs moisture"
        ]
    },
    // [E] handbook §1/§6(2): fz 0.08-0.13 at Ø6 (k ≈ 0.013-0.022);
    // minimum fz ≈ 0.05-0.08 mm/tooth at Ø3-6 -- below it the material
    // melts (§4). The absolute band below enforces that minimum.
    // O-flute (single flute, positive spiral) preferred; never plunge
    // vertically, ramp only.
    acrylic: {
        label: "acrylic (PMMA)",
        kLo: 0.013,
        kHi: 0.022,
        // absolute fz band (mm/tooth): enforces the melt-avoidance minimum
        fzAbsLo: 0.05,
        fzAbsHi: 0.13,
        docPct: [0.5, 1.0],
        plungePct: [0.25, 0.4],
        smallFz: [0.03, 0.08],
        warnings: [
            "acrylic: melts at low chip load and/or high rpm -- keep fz " +
                "above ~0.05-0.08 mm/tooth at Ø3-6; prefer single-flute " +
                "O-flute bits; never plunge vertically, ramp only; " +
                "blow/vacuum chips away to avoid re-welding"
        ]
    }
};

// legacy material keys kept resolvable after table splits
// ("plastic" was split into pom / pa)
const MATERIAL_ALIASES = {
    plastic: "pom"
};

// small diameter tools: hard fz clamp below this diameter -- linear
// fz ≈ k×D model does not apply (fragility of the tool becomes the
// limit). NOTE: fz(D) is already nonlinear below Ø4 (LINEAR_MIN_MM).
const SMALL_DIAM_MM = 3;
// fallback small-tool fz band; every MATERIALS record carries its own
// `smallFz` (metals 0.01-0.02, wood/MDF/plastics 0.03-0.08 -- handbook
// §2/§6(4): the old all-materials 0.01-0.02 band burns/melts non-metals)
const SMALL_FZ_MM = [0.01, 0.02];
// below this diameter the linear model degrades (handbook §2): the
// §1 diameter table is authoritative; only a warning is issued here
const LINEAR_MIN_MM = 4;

// fallback plunge rate as a fraction of feed rate [conservative,
// aggressive]; every MATERIALS record carries its own `plungePct`
// (metals 0.25-0.33, wood 0.4-0.6 -- handbook §3)
const PLUNGE_PCT = [1 / 3, 1 / 2];

const MM_PER_INCH = 25.4;

function clamp(val, lo, hi) {
    return Math.min(Math.max(val, lo), hi);
}

/**
 * resolve the material record for a material key or display label
 *
 * @param {string} material key or label from MATERIALS
 * @returns {object|undefined} material record
 */
function lookupMaterial(material) {
    if (!material) return undefined;
    const key = String(material).toLowerCase().trim();
    const resolved = MATERIAL_ALIASES[key] ?? key;
    if (MATERIALS[resolved]) return MATERIALS[resolved];
    return Object.values(MATERIALS)
        .find(m => m.label.toLowerCase() === key);
}

/**
 * resolve a tool record. accepts either a plain settings tool record
 * ({ flute_diam, metric, flutes, ... }) or a Tool instance from
 * mode/cam/core/tool.js
 *
 * @param {object|Tool} tool tool record or Tool instance
 * @returns {object} normalized { diamMm, flutes, metric }
 */
function toolSpec(tool) {
    const rec = tool?.tool ?? tool;
    const metric = rec?.metric !== false;
    const diam = (rec?.flute_diam ?? 0) * (metric ? 1 : MM_PER_INCH);
    return {
        diamMm: diam,
        flutes: Math.max(1, rec?.flutes ?? 2),
        metric
    };
}

/**
 * fixed fz band applied below SMALL_DIAM_MM (per-material)
 *
 * @param {object} mat material record from MATERIALS
 * @returns {number[]} [fzLo, fzHi] in mm/tooth
 */
function smallFzBand(mat) {
    return (mat.smallFz ?? SMALL_FZ_MM).slice();
}

/**
 * compute a recommended fz range in mm/tooth for a material + diameter
 *
 * @param {object} mat material record from MATERIALS
 * @param {number} diamMm tool diameter in mm
 * @returns {number[]} [fzLo, fzHi] in mm/tooth
 */
function fzRange(mat, diamMm) {
    // small tools: fixed per-material band, linear model does not apply
    if (diamMm < SMALL_DIAM_MM) {
        return smallFzBand(mat);
    }
    let lo = mat.kLo * diamMm,
        hi = mat.kHi * diamMm;
    // materials with an absolute fz band (acrylic) are clamped to it
    if (mat.fzAbsLo !== undefined) {
        lo = clamp(lo, mat.fzAbsLo, mat.fzAbsHi);
        hi = clamp(hi, mat.fzAbsLo, mat.fzAbsHi);
    }
    return [lo, hi];
}

/**
 * recommend feed/speed parameters for a material/tool/spindle combo.
 * advisory only -- callers must present these to the user, never
 * apply them silently.
 *
 * @param {string} material material key or label (see MATERIALS)
 * @param {object|Tool} tool tool record or Tool instance
 * @param {number} spindle spindle speed in RPM
 * @param {object} [opts] options
 * @param {number} [opts.flutes] override tool flute count
 * @param {string} [opts.units] output units "mm" (default) or "inch"
 * @param {number} [opts.docPct] override max DOC fraction of diameter
 * @returns {object} {
 *   fzLo, fzHi         feed per tooth (mm or inch per tooth)
 *   vfLo, vfHi         feed rate Vf (mm/min or inch/min)
 *   plungeLo, plungeHi plunge rate (material-dependent fraction of Vf)
 *   maxDoc             max depth of cut (conservative, tool units)
 *   maxDocRange        [conservative, aggressive] max DOC
 *   warnings           advisory warnings list
 * }
 */
function recommend(material, tool, spindle, opts = {}) {
    const warnings = [];
    const mat = lookupMaterial(material);
    const spec = toolSpec(tool);

    if (!mat) {
        warnings.push(`unknown material "${material}"`);
        return { fzLo: 0, fzHi: 0, vfLo: 0, vfHi: 0, plungeLo: 0, plungeHi: 0, maxDoc: 0, maxDocRange: [0, 0], warnings };
    }
    if (!(spindle > 0)) {
        warnings.push("spindle speed must be > 0");
    }
    if (!(spec.diamMm > 0)) {
        warnings.push("tool flute diameter must be > 0");
    }

    const flutes = opts.flutes ?? spec.flutes;
    const outInch = (opts.units ?? (spec.metric ? "mm" : "inch")) === "inch";
    const unitScale = outInch ? 1 / MM_PER_INCH : 1;
    const rpm = Math.max(0, spindle);

    let [fzLo, fzHi] = fzRange(mat, spec.diamMm);

    if (spec.diamMm > 0 && spec.diamMm < SMALL_DIAM_MM) {
        const [sfLo, sfHi] = smallFzBand(mat);
        warnings.push(`tool diameter ${spec.diamMm.toFixed(2)}mm is below ${SMALL_DIAM_MM}mm: ` +
            `linear fz model does not apply, using fixed ${mat.label} fz band ` +
            `${sfLo}-${sfHi} mm/tooth`);
    } else if (spec.diamMm > 0 && spec.diamMm < LINEAR_MIN_MM) {
        warnings.push(`tool diameter ${spec.diamMm.toFixed(2)}mm is below ${LINEAR_MIN_MM}mm: ` +
            `fz(D) is nonlinear here -- handbook table values are more ` +
            `accurate than this linear k×D estimate`);
    }
    if (spec.diamMm > 20) {
        warnings.push("tool diameter above ~20mm: feed may be limited by " +
            "machine power/rigidity rather than the tool");
    }
    // Vf = rpm × flutes × fz  (mm/min)
    const vfLo = rpm * flutes * fzLo;
    const vfHi = rpm * flutes * fzHi;

    // max depth of cut as a fraction of diameter
    const docPctLo = opts.docPct ?? mat.docPct[0];
    const docLo = docPctLo * spec.diamMm;
    const docHi = mat.docPct[1] * spec.diamMm;

    for (const w of mat.warnings) {
        warnings.push(w);
    }

    // plunge fraction: per-material when present (metals ~0.25-0.33,
    // wood ~0.4-0.6), global fallback otherwise
    const [plungeLoPct, plungeHiPct] = mat.plungePct ?? PLUNGE_PCT;

    return {
        fzLo: fzLo * unitScale,
        fzHi: fzHi * unitScale,
        vfLo: vfLo * unitScale,
        vfHi: vfHi * unitScale,
        plungeLo: vfLo * plungeLoPct * unitScale,
        plungeHi: vfHi * plungeHiPct * unitScale,
        maxDoc: docLo * unitScale,
        maxDocRange: [docLo * unitScale, docHi * unitScale],
        warnings
    };
}

export {
    MATERIALS,
    MM_PER_INCH,
    lookupMaterial,
    recommend
};
