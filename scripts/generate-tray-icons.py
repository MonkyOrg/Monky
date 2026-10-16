# /// script
# requires-python = ">=3.9,<3.13"
# dependencies = [
#   "numpy==2.0.2",
#   "opencv-python-headless==4.10.0.84",
#   "pillow==11.3.0",
# ]
# ///
"""Generate the tray monkey icons in apps/client/build/tray from the originals in images/tray.

Inputs (1024 px, all drawn on the same head, so they line up pixel for pixel):
  idle.png, call.png (the logo), talk.png, mute.png, deaf.png
  call-3d.jpg         the logo wearing 3D cinema glasses; only the glasses are taken from it
  call-megaphone.jpg  the logo without the boom mic, holding a megaphone; only the megaphone and the
                      hand are taken from it

Outputs, as {pose}[-mega][-3d][-rec]: idle, and every in-call pose (call, talk, mute, deaf, and call-mega
and talk-mega holding the megaphone) with and without the glasses and with and without the REC frame:
  {key}.ico             Windows: PNG frames of 16, 20, 24, 28, 32, 36, 40, 48 and 64 px
  {key}.png, @2x.png    macOS: 18 and 36 px

The Windows tray draws the icon in a fixed square (16 px at 100% scale), so each pose is split into
layers and the ears, headset cups and hands are pulled towards the head, which then fills more of the
square. The headset grey and the brown fur are lightened to stand out on dark taskbars. Every frame is
rendered straight from 1024 px with premultiplied alpha, plus a light unsharp mask up to 24 px. The REC
frame is drawn at each final size instead, so its thin lines stay on whole pixels.

Usage:
  uv run scripts/generate-tray-icons.py [--out DIR]
  python3 scripts/generate-tray-icons.py [--out DIR]    (with the dependencies above installed)

The committed icons were generated with the pinned versions; other versions may round a few pixels
differently.
"""
import argparse
import io
import struct
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / 'images' / 'tray'
DEFAULT_OUT = ROOT / 'apps' / 'client' / 'build' / 'tray'

POSES = ['idle', 'call', 'talk', 'mute', 'deaf']
IN_CALL = ['call', 'talk', 'mute', 'deaf', 'call-mega', 'talk-mega']
KEYS = ['idle'] + [base + glasses + rec for rec in ('', '-rec') for glasses in ('', '-3d') for base in IN_CALL]
ICO_SIZES = [16, 20, 24, 28, 32, 36, 40, 48, 64]  # order checked by apps/client/test/trayManager.test.cjs
MAC_SIZES = [(18, ''), (36, '@2x')]

CX = 511.5          # symmetry axis
EAR_Y = (400, 722)  # rows with ears
HANGER_X = 184.5    # centre of the left headband hanger
ARC_TOP = 93        # top of the headband arc
Y0 = 405            # row where the hangers meet the cups

# Reframing, in 1024 px units: the cups and hangers move in by CUPS, the ears by EARS (EARS_IDLE
# without a headset), the deaf hands by HANDS, and the top of the headband arc drops by ARC_DROP.
CUPS, EARS, EARS_IDLE, HANDS, ARC_DROP = 20, 84, 56, 72, 30
BOOM_Y = 715                # below this row the right headset piece is the mic boom and capsule
MEGAPHONE_SHIFT = (-20, -8) # the megaphone follows the right cup in, and rises to fit the square

# Windows: one square for every pose, so the head stays put when the state changes.
WIN_SIDE = 861
WIN_X0, WIN_Y0 = 512 - WIN_SIDE / 2, 525.5 - WIN_SIDE / 2
WIN_BOX = (WIN_X0, WIN_Y0, WIN_X0 + WIN_SIDE, WIN_Y0 + WIN_SIDE)
# macOS: 18 pt icons at one scale for every pose (the tallest silhouettes are ~16 pt). The in-call
# poses share one vertical centre; idle is centred on its own silhouette (top and bottom rows).
MAC_SIDE = 905.0
MAC_CENTRE_Y = {'idle': (184 + 929) / 2}
MAC_CENTRE_Y_DEFAULT = (122 + 928) / 2


def mac_box(pose):
    yc = MAC_CENTRE_Y.get(pose, MAC_CENTRE_Y_DEFAULT)
    return (512 - MAC_SIDE / 2, yc - MAC_SIDE / 2, 512 + MAC_SIDE / 2, yc + MAC_SIDE / 2)


# ---------------------------------------------------------------- sources
def load(pose):
    return np.array(Image.open(SOURCES / f'{pose}.png').convert('RGBA')).astype(np.float64)


def load_glasses_source():
    return np.array(Image.open(SOURCES / 'call-3d.jpg').convert('RGB')).astype(np.float64)


def load_megaphone_source():
    return np.array(Image.open(SOURCES / 'call-megaphone.jpg').convert('RGB')).astype(np.float64)


def premul(im):
    out = im.copy(); out[..., :3] *= out[..., 3:4] / 255.0; return out


def unpremul(P):
    out = P.copy(); a = out[..., 3:4]
    out[..., :3] = np.where(a > 0, out[..., :3] * 255.0 / np.maximum(a, 1e-6), 0)
    return np.clip(out, 0, 255)


def smooth(t):
    t = np.clip(t, 0, 1); return t * t * (3 - 2 * t)


def clean(P):
    P = P.copy(); P[..., 3] = np.clip(P[..., 3], 0, 255)
    P[..., :3] = np.clip(P[..., :3], 0, P[..., 3:4]); return P


# ---------------------------------------------------------------- layers
def _runs(mask):
    xs = np.nonzero(mask)[0]
    if not len(xs): return []
    br = np.nonzero(np.diff(xs) > 1)[0]
    return list(zip([xs[0]] + list(xs[br + 1]), list(xs[br]) + [xs[-1]]))


@lru_cache(maxsize=None)
def head_contour():
    """Outer edge of the head outline (xL, xR per row). Measured on idle, where the ear/head
    junction is visible: a dark band of ~16 px with fur on the inside."""
    im = load('idle'); a = im[..., 3]; mx = im[..., :3].max(-1)
    dark = (mx < 90) & (a > 128)
    xL = np.full(1024, np.nan); xR = np.full(1024, np.nan)
    for y in range(1024):
        op = _runs(a[y] > 128)
        run = [r for r in op if r[0] <= 511 <= r[1]]
        if not run: continue
        s, e = run[0]
        if s >= 180: xL[y] = s
        else:
            c = [r for r in _runs(dark[y, :300]) if 200 <= r[1] <= 245]
            if c: r = max(c, key=lambda r: r[1]); xL[y] = max(r[0], r[1] - 17)
        if e <= 843: xR[y] = e
        else:
            c = [(s2 + 724, e2 + 724) for s2, e2 in _runs(dark[y, 724:]) if 778 <= s2 + 724 <= 823]
            if c: r = min(c, key=lambda r: r[0]); xR[y] = min(r[1], r[0] + 17)
    for arr in (xL, xR):
        ok = ~np.isnan(arr); ys = np.arange(1024)
        arr[~ok] = np.interp(ys[~ok], ys[ok], arr[ok])
        sm = cv2.GaussianBlur(arr.reshape(-1, 1).astype(np.float32), (1, 0), 0, sigmaY=2.5).ravel()
        arr[EAR_Y[0] - 20:EAR_Y[1] + 20] = sm[EAR_Y[0] - 20:EAR_Y[1] + 20]
    return xL, xR


def _grey(im):
    rgb = im[..., :3]; mx = rgb.max(-1); mn = rgb.min(-1)
    return (mx - mn) <= 0.18 * mx + 6, mx


def headset_masks(im, grow=21):
    """Headband and hangers (band) and the pieces over the monkey (over), each with its dark outline."""
    a = im[..., 3]; gray, mx = _grey(im)
    g = gray & (a >= 200) & (mx >= 25)
    n, lab, st, cen = cv2.connectedComponentsWithStats(g.astype(np.uint8), 8)
    band = np.zeros(a.shape, bool); over = np.zeros(a.shape, bool)
    for i in range(1, n):
        x, y, w, h, ar = st[i]; cx, cy = cen[i]
        if w > 900 or ar < 300: continue
        if 330 < cx < 700 and 500 < cy < 660: continue        # eye highlights
        if cy < 396: band |= lab == i
        elif (cx < 240 or cx > 785) or (cx > 540 and cy > 640): over |= lab == i
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    band = cv2.morphologyEx(band.astype(np.uint8), cv2.MORPH_CLOSE, k).astype(bool)
    over = cv2.morphologyEx(over.astype(np.uint8), cv2.MORPH_CLOSE, k).astype(bool)
    dark = mx < 70
    fill = (a >= 200) & ~dark & ~gray
    dt = lambda m: cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 5)
    d_band, d_over, d_fill = dt(band), dt(over), dt(fill)
    soft = dark | gray | (a < 250)
    Hb = band | (soft & (d_band <= grow) & (d_band < d_fill) & (d_band <= d_over))
    Ho = over | (soft & (d_over <= grow) & (d_over < d_fill) & (d_over < d_band))
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    edge = a < 200
    Hb |= cv2.dilate(Hb.astype(np.uint8), k3).astype(bool) & edge & ~Ho
    Ho |= cv2.dilate(Ho.astype(np.uint8), k3).astype(bool) & edge & ~Hb
    return Hb, Ho


def hands_mask(deaf, mute, Ho_deaf):
    """Hands and forearms of deaf: what differs from mute at the sides (where mute shows an ear,
    a cup or the background), without the grey headset pieces of deaf itself."""
    Pd, Pm = premul(deaf), premul(mute)
    diff = np.abs(Pd - Pm).max(-1) > 60
    gray, mx = _grey(deaf)
    hs_grey = Ho_deaf & gray & (mx >= 25)
    yy, xx = np.mgrid[0:1024, 0:1024]
    out = np.zeros((1024, 1024), bool)
    low_hs = Ho_deaf & (yy >= 740)                         # the boom and capsule of deaf stay put
    for side in ('L', 'R'):
        zone = ((xx < 262) if side == 'L' else (xx > 762)) & (yy > 440)
        m = diff & zone & ~hs_grey & ~low_hs
        m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
        if n < 2: continue
        big = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
        m = (lab == big).astype(np.uint8)
        # fill inner holes (creases and highlights that match mute)
        ff = m.copy(); h, w = ff.shape
        cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
        m = m | (1 - ff)
        # drop thin strips of the jaw outline stuck to the hand
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (23, 23)))
        n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
        if n < 2: continue
        m = (lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))).astype(bool)
        out |= m & (deaf[..., 3] > 0) & ~hs_grey & ~low_hs & zone
    return out


def cup_ring(im, Ho, zone, t=15.5, col=(16, 9, 7)):
    """The outline between cup and ear is shared, and half of it goes with the ear, which slides
    under the cup. Redraw the cup outline over the ear zone."""
    a = im[..., 3]; gray, mx = _grey(im)
    core = (Ho & gray & (a >= 200) & (mx >= 25)).astype(np.uint8)
    core = cv2.morphologyEx(core, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))).astype(bool)
    d = cv2.distanceTransform((~core).astype(np.uint8), cv2.DIST_L2, 5)
    ear = zone & (a >= 200) & (mx >= 80) & ~gray                 # ear skin and fur
    d_ear = cv2.distanceTransform((~ear).astype(np.uint8), cv2.DIST_L2, 5)
    al = np.clip(t + 0.5 - d, 0, 1) * (zone & ~core) * np.clip(19 - d_ear, 0, 1)
    R = np.zeros(im.shape[:2] + (4,)); R[..., 3] = al * 255
    R[..., :3] = np.array(col, float) * al[..., None]
    return R


def decompose(name):
    """Premultiplied layers: ear_L, ear_R, head, band, over_L, over_R, hands_L, hands_R."""
    xL, xR = head_contour()
    yy, xx = np.mgrid[0:1024, 0:1024]
    ear_y = (yy >= EAR_Y[0]) & (yy <= EAR_Y[1])
    zone_L = (xx < xL[yy]) & ear_y; zone_R = (xx > xR[yy]) & ear_y
    mask_src = 'call' if name == 'talk' else name
    im = load(name); ims = load(mask_src) if mask_src != name else im
    Hb, Ho = headset_masks(ims.astype(np.int32))
    P = premul(im)
    hands = np.zeros((1024, 1024), bool)
    L = {}
    if name == 'deaf':
        mute = load('mute'); Pm = premul(mute)
        Hb_m, Ho_m = headset_masks(mute.astype(np.int32))
        hands = hands_mask(im, mute, Ho)
        L['ear_L'], L['ear_R'] = (layers('mute')[k].astype(np.float64) for k in ('ear_L', 'ear_R'))
        low = yy >= 760
        over = np.where((Ho & low)[..., None], P, 0) + np.where((Ho_m & ~low)[..., None], Pm, 0)
        ring = cup_ring(mute, Ho_m, zone_L | zone_R)
        outside = ((xx < xL[yy] - 4) | (xx > xR[yy] + 4)) & (yy > 440)   # forearm leftovers
        excl = Ho | Hb | hands | zone_L | zone_R | (Ho_m & ~low) | outside
    else:
        a = ims[..., 3] > 0
        L['ear_L'] = np.where((zone_L & ~Hb & ~Ho & a)[..., None], P, 0)
        L['ear_R'] = np.where((zone_R & ~Hb & ~Ho & a)[..., None], P, 0)
        over = np.where(Ho[..., None], P, 0)
        ring = cup_ring(ims, Ho, zone_L | zone_R)
        excl = Ho | Hb | zone_L | zone_R
    over = over + ring * (1 - over[..., 3:4] / 255.0)
    L['band'] = np.where(Hb[..., None], P, 0)
    L['over_L'] = np.where((xx < CX)[..., None], over, 0)
    L['over_R'] = np.where((xx >= CX)[..., None], over, 0)
    L['hands_L'] = np.where((hands & (xx < CX))[..., None], P, 0)
    L['hands_R'] = np.where((hands & (xx >= CX))[..., None], P, 0)
    L['head'] = np.where((~excl & ~hands)[..., None], P, 0)
    return L


@lru_cache(maxsize=None)
def layers(name):
    # Kept as float32: halves the memory, and the committed icons were rendered from float32 layers.
    return {k: v.astype(np.float32) for k, v in decompose(name).items()}


# ---------------------------------------------------------------- glasses
def fill_holes(m):
    m = m.astype(np.uint8); ff = m.copy(); h, w = m.shape
    cv2.floodFill(ff, np.zeros((h + 2, w + 2), np.uint8), (0, 0), 1)
    return (m | (1 - ff)).astype(bool)


def extract_glasses():
    """The 3D glasses (frame, lenses and outline) cut out of call-3d.jpg, which matches call.png
    pixel for pixel."""
    src = load_glasses_source()
    logo = load('call')
    lb = logo[..., :3] * logo[..., 3:4] / 255.0
    yy, xx = np.mgrid[0:1024, 0:1024]
    R = (xx >= 195) & (xx <= 835) & (yy >= 420) & (yy <= 690)
    hsv = cv2.cvtColor((src / 255.0).astype(np.float32), cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    white = (s < 0.22) & (v > 0.70)
    cyan = (h > 160) & (h < 210) & (s > 0.35) & (v > 0.30)
    red = ((h < 18) | (h > 340)) & (s > 0.50) & (v > 0.35)
    core = ((white | cyan | red) & R).astype(np.uint8)
    core = cv2.morphologyEx(core, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(core, 8)
    keep = np.zeros_like(core, bool)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] > 3000: keep |= lab == i
    core = fill_holes(keep)
    D = np.abs(src - lb).max(-1) > 45
    d_core = cv2.distanceTransform((~core).astype(np.uint8), cv2.DIST_L2, 5)
    # the whole dark outline of the frame, also where the logo was already dark (top of the eyes)
    ring = (src.max(-1) < 110) & (d_core <= 14)
    M = core | ((ring | (d_core <= 3)) & R) | (D & (d_core <= 18) & R)
    M = cv2.morphologyEx(M.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    M = cv2.morphologyEx(M, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(M, 8)
    M = lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
    M = fill_holes(M)
    inner = cv2.distanceTransform(M.astype(np.uint8), cv2.DIST_L2, 5)
    alpha = np.clip(inner / 1.5, 0, 1)
    G = np.zeros((1024, 1024, 4))
    G[..., :3] = src * alpha[..., None]; G[..., 3] = alpha * 255
    return G


@lru_cache(maxsize=None)
def glasses_layer():
    # Kept as float32, like the layer the committed icons were rendered from.
    return extract_glasses().astype(np.float32)


def pose_glasses(name):
    """Glasses for a pose. Where the brows rise above the frame (mute, deaf), cover what touches
    the frame with the face of call-3d.jpg."""
    G = glasses_layer().astype(np.float64)
    if name in ('call', 'talk'): return G
    head = layers(name)['head'].astype(np.float64)
    call_head = layers('call')['head'].astype(np.float64)
    src = load_glasses_source()
    gA = G[..., 3] > 128
    yy, xx = np.mgrid[0:1024, 0:1024]
    top = np.where(gA.any(0), gA.argmax(0), 0)
    above = (yy < top[xx] + 4) & (yy > 330) & (xx > 230) & (xx < 795)
    d = (np.abs(head - call_head).max(-1) > 40) & above & ~gA
    near = cv2.dilate(gA.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))).astype(bool)
    n, lab, st, _ = cv2.connectedComponentsWithStats(d.astype(np.uint8), 8)
    patch = np.zeros(d.shape, bool)
    for i in range(1, n):
        comp = lab == i
        if st[i, cv2.CC_STAT_AREA] >= 40 and (comp & near).any(): patch |= comp
    if not patch.any(): return G
    patch = cv2.dilate(patch.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    a = np.clip(cv2.GaussianBlur(patch.astype(np.float32), (0, 0), 1.5) * 1.6, 0, 1).astype(np.float64)
    a *= head[..., 3] / 255.0
    Pt = np.zeros((1024, 1024, 4)); Pt[..., :3] = src * a[..., None]; Pt[..., 3] = a * 255
    return G + Pt * (1 - G[..., 3:4] / 255.0)


# ---------------------------------------------------------------- megaphone
def _ellipse(d):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))


def _largest(m):
    n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    return lab == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])


def extract_megaphone():
    """The megaphone and the hand holding it (with their outline), cut out of call-megaphone.jpg,
    which matches call.png pixel for pixel apart from the mic it no longer has."""
    src = load_megaphone_source()
    call, idle = load('call'), load('idle')
    yy, xx = np.mgrid[0:1024, 0:1024]
    _, Ho = headset_masks(call.astype(np.int32))
    ref = np.where((Ho & (yy >= BOOM_Y))[..., None], idle, call)       # the logo without the mic
    D = np.abs(src - ref[..., :3] * ref[..., 3:4] / 255.0).max(-1) > 50
    R = (xx >= 580) & (yy >= 570)
    hsv = cv2.cvtColor((src / 255.0).astype(np.float32), cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    red = ((h < 18) | (h > 340)) & (s > 0.50) & (v > 0.35)
    grey = (s < 0.15) & (v > 0.45)
    core = cv2.morphologyEx(((red | grey) & R).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(core, 8)
    keep = np.zeros(core.shape, bool)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] > 3000: keep |= lab == i
    # the hand: what differs from the logo, without the thin outline of the mic that is gone
    M = cv2.morphologyEx((D & R).astype(np.uint8), cv2.MORPH_OPEN, _ellipse(11)).astype(bool) | keep
    M = fill_holes(_largest(cv2.morphologyEx(M.astype(np.uint8), cv2.MORPH_CLOSE, _ellipse(21))))
    d = cv2.distanceTransform((~M).astype(np.uint8), cv2.DIST_L2, 5)
    M = M | ((src.max(-1) < 110) & (d <= 14) & R) | (d <= 2)              # the dark outline
    M = cv2.morphologyEx(M.astype(np.uint8), cv2.MORPH_CLOSE, _ellipse(7))
    M = fill_holes(_largest(cv2.morphologyEx(M, cv2.MORPH_OPEN, _ellipse(5))))
    alpha = np.clip(cv2.distanceTransform(M.astype(np.uint8), cv2.DIST_L2, 5) / 1.5, 0, 1)
    G = np.zeros((1024, 1024, 4))
    G[..., :3] = src * alpha[..., None]; G[..., 3] = alpha * 255
    return shift(G, *MEGAPHONE_SHIFT)


@lru_cache(maxsize=None)
def megaphone_layer():
    return extract_megaphone().astype(np.float32)


def drop_mic(L):
    """Take the boom and capsule off the right headset piece, and show the face of idle under them."""
    out = dict(L)
    yy = np.mgrid[0:1024, 0:1024][0]
    boom = (L['over_R'][..., 3] > 0) & (yy >= BOOM_Y)
    out['over_R'] = np.where(boom[..., None], 0, L['over_R'])
    # the dark rim of the capsule went with the face: replace a margin around it too
    zone = cv2.dilate(boom.astype(np.uint8), _ellipse(25)).astype(bool) & (yy >= BOOM_Y)
    out['head'] = np.where(zone[..., None], layers('idle')['head'].astype(np.float64), L['head'])
    return out


# ---------------------------------------------------------------- composition
def shift(P, dx, dy=0):
    out = np.zeros_like(P)
    h, w = P.shape[:2]
    xs0, xs1 = max(0, -dx), min(w, w - dx); ys0, ys1 = max(0, -dy), min(h, h - dy)
    out[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx] = P[ys0:ys1, xs0:xs1]
    return out


def _remap(P, xs, ys):
    return cv2.remap(P.astype(np.float32), xs.astype(np.float32), ys.astype(np.float32),
                     cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=0).astype(np.float64)


def warp_band(P, c, dy0):
    """Bring the hangers in by c and lower the top of the arc by dy0; rows below Y0 stay."""
    s = (CX - HANGER_X - c) / (CX - HANGER_X)
    k = (Y0 - ARC_TOP - dy0) / (Y0 - ARC_TOP)
    yy, xx = np.mgrid[0:1024, 0:1024].astype(np.float64)
    xs = CX + (xx - CX) / s
    ys = np.where(yy < Y0, Y0 - (Y0 - yy) / k, yy)
    return clean(_remap(P, xs, ys))


def warp_over_R(P, c):
    """The right cup moves by -c; the mic boom tapers that offset down to the capsule, which stays put."""
    yy, xx = np.mgrid[0:1024, 0:1024].astype(np.float64)
    cup_w = 1 - smooth((yy - 715) / 45.0)
    xs = xx.copy()
    for _ in range(8):
        w = np.maximum(cup_w, smooth((xs - 760) / 100.0))
        xs = xx + c * w
    return clean(_remap(P, xs, yy))


def over(dst, src):
    return src + dst * (1 - src[..., 3:4] / 255.0)


def lift_headset(L, gamma=0.55):
    """Lighten the headset grey (headband, cups, boom, capsule), keeping its dark outline."""
    out = dict(L)
    for k in ('band', 'over_L', 'over_R'):
        U = unpremul(L[k]); rgb = U[..., :3]; mx = rgb.max(-1)
        mapped = 255.0 * (rgb / 255.0) ** gamma
        w = smooth((mx - 24) / 18.0)[..., None]
        gray = ((rgb.max(-1) - rgb.min(-1)) <= 0.18 * mx + 6)[..., None]
        U[..., :3] = np.where(gray, rgb + w * (mapped - rgb), rgb)
        out[k] = premul(U)
    return out


def lift_fur(L, amount=0.18):
    """Lighten the brown fur, leaving the beige skin, the outline and the eyes alone."""
    out = dict(L)
    for k in ('ear_L', 'ear_R', 'head', 'hands_L', 'hands_R'):
        U = unpremul(L[k]); rgb = U[..., :3]
        hsv = cv2.cvtColor((rgb / 255.0).astype(np.float32), cv2.COLOR_RGB2HSV)
        h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
        fur = (h >= 15) & (h <= 35) & (s > 0.6) & (v > 0.25) & (v < 0.7)
        w = smooth((v - 0.25) / 0.12) * (1 - smooth((v - 0.62) / 0.08))
        hsv[..., 2] = np.where(fur, v * (1 + amount * w), v)
        U[..., :3] = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB).astype(np.float64) * 255.0
        out[k] = premul(U)
    return out


def compose(name, glasses=None, megaphone=False):
    """The reframed pose at 1024 px, premultiplied, drawn back to front."""
    L = {k: v.astype(np.float64) for k, v in layers(name).items()}
    if megaphone: L = drop_mic(L)
    L = lift_fur(lift_headset(L))
    ears = EARS_IDLE if name == 'idle' else EARS
    hands = HANDS if name == 'deaf' else 0
    out = np.zeros((1024, 1024, 4))
    out = over(out, shift(L['ear_L'], ears)); out = over(out, shift(L['ear_R'], -ears))
    out = over(out, L['head'])
    if glasses is not None: out = over(out, glasses)
    out = over(out, warp_band(L['band'], CUPS, ARC_DROP))
    out = over(out, shift(L['over_L'], CUPS)); out = over(out, warp_over_R(L['over_R'], CUPS))
    out = over(out, shift(L['hands_L'], hands)); out = over(out, shift(L['hands_R'], -hands))
    if megaphone: out = over(out, megaphone_layer().astype(np.float64))
    return clean(out)


# ---------------------------------------------------------------- output
def resize(P, size, box):
    channels = [np.array(Image.fromarray(P[..., i].astype(np.float32))
                         .resize((size, size), Image.Resampling.LANCZOS, box=box)) for i in range(4)]
    return np.stack(channels, -1).astype(np.float64)


def usm(P, sigma=0.6, amount=0.35):
    blur = cv2.GaussianBlur(P.astype(np.float32), (0, 0), sigma).astype(np.float64)
    return P + amount * (P - blur)


def render(P, size, box):
    out = resize(P, size, box)
    if size <= 24: out = usm(out)
    return clean(out)


REC_RED = (229, 57, 53)
REC_GREY = (138, 138, 138)
REC_SS = 8  # supersampling of the REC frame


def rec_frame(P):
    """The REC frame on a rendered icon: grey corner brackets behind the monkey, and a red dot over its
    top-left corner, with a thin transparent gap so it reads on any taskbar."""
    size = P.shape[0]; n = size * REC_SS
    t = max(1, round(size / 16)) * REC_SS                    # whole pixels
    arm = round(size * 0.3) * REC_SS
    br = np.zeros((n, n), np.uint8)
    for cx, cy in ((n, 0), (0, n), (n, n)):                  # the dot takes the top-left corner
        x0 = 0 if cx == 0 else n - arm; y0 = 0 if cy == 0 else n - t
        br[y0:y0 + t, x0:x0 + arm] = 255
        x0 = 0 if cx == 0 else n - t; y0 = 0 if cy == 0 else n - arm
        br[y0:y0 + arm, x0:x0 + t] = 255
    r = size * 0.13 * REC_SS; c = r
    dot = np.zeros((n, n), np.uint8); cv2.circle(dot, (round(c), round(c)), round(r), 255, -1, cv2.LINE_AA)
    gap = np.zeros((n, n), np.uint8)
    cv2.circle(gap, (round(c), round(c)), round(r + max(1, size / 24) * REC_SS), 255, -1, cv2.LINE_AA)
    down = lambda m: cv2.resize(m.astype(np.float32) / 255.0, (size, size), interpolation=cv2.INTER_AREA).astype(np.float64)
    a_br, a_dot, a_gap = down(br), down(dot), down(gap)
    layer = lambda a, col: np.concatenate([a[..., None] * np.array(col, float), a[..., None] * 255], -1)
    out = over(layer(a_br, REC_GREY), P) * (1 - a_gap[..., None])
    return clean(over(out, layer(a_dot, REC_RED)))


def to_rgba(P):
    return Image.fromarray(np.round(unpremul(P)).astype(np.uint8))


def png_bytes(img):
    b = io.BytesIO(); img.save(b, 'PNG', optimize=True); return b.getvalue()


def ico_bytes(imgs):
    data = [png_bytes(im) for im in imgs]
    head = struct.pack('<HHH', 0, 1, len(imgs)); entries = b''; off = 6 + 16 * len(imgs)
    for im, d in zip(imgs, data):
        entries += struct.pack('<BBBBHHII', im.width, im.height, 0, 0, 1, 32, len(d), off); off += len(d)
    return head + entries + b''.join(data)


def main():
    parser = argparse.ArgumentParser(description='Generate the tray monkey icons from images/tray.')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT,
                        help='output directory (default: apps/client/build/tray)')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for key in KEYS:
        pose = key.split('-')[0]; flags = key.split('-')[1:]
        P = compose(pose, pose_glasses(pose) if '3d' in flags else None, megaphone='mega' in flags)
        draw = (lambda Q: rec_frame(Q)) if 'rec' in flags else (lambda Q: Q)
        (args.out / f'{key}.ico').write_bytes(ico_bytes([to_rgba(draw(render(P, size, WIN_BOX))) for size in ICO_SIZES]))
        for size, suffix in MAC_SIZES:
            (args.out / f'{key}{suffix}.png').write_bytes(png_bytes(to_rgba(draw(render(P, size, mac_box(pose))))))
        print('wrote', key, flush=True)


if __name__ == '__main__':
    main()
