// Rendering only. Every number on screen comes from src/core.mjs.
import * as THREE from 'three';
import { MODES, depthBinWidth, classifyPair, chooseFix, chartDistances } from './src/core.mjs';

const SEP = 0.02;         // 2 cm of eye-depth separation between the two quads
const FAR = 3000;

const host = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(host.clientWidth, host.clientHeight);
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e13);
const camera = new THREE.PerspectiveCamera(60, host.clientWidth / host.clientHeight, 0.1, FAR);
camera.position.set(0, 1.7, 0);
camera.lookAt(0, 1.7, -1);

// A distant "painted panel" and its 2 cm-deeper twin. At a bad near plane the
// two depth values collide and the GPU shows stripes.
const quadGeo = new THREE.PlaneGeometry(900, 600);
const back = new THREE.Mesh(quadGeo, new THREE.MeshBasicMaterial({ color: 0x1b4f8a }));
const front = new THREE.Mesh(quadGeo, new THREE.MeshBasicMaterial({ color: 0xd4552f }));
scene.add(back, front);

const grid = new THREE.GridHelper(2000, 40, 0x24384f, 0x172232);
grid.position.y = -1.7;
scene.add(grid);

const nearEl = document.getElementById('near');
const distEl = document.getElementById('dist');
const nearVal = document.getElementById('nearVal');
const distVal = document.getElementById('distVal');

const state = { near: 0.1, distance: 1000 };

function place() {
  camera.near = state.near;
  camera.updateProjectionMatrix();
  back.position.set(0, 1.7, -state.distance);
  front.position.set(0, 1.7, -state.distance - SEP);
}

const fmt = (x) => x >= 1 ? x.toFixed(2) : x >= 1e-3 ? x.toExponential(2) : x.toExponential(3);
const cell = (id, text, cls) => { const el = document.getElementById(id); el.textContent = text; el.className = cls || ''; };

function refresh() {
  nearVal.textContent = state.near.toFixed(2);
  distVal.textContent = state.distance.toFixed(0);
  place();

  const widths = {};
  for (const mode of MODES) widths[mode] = depthBinWidth(state.distance, mode, state.near, FAR);
  cell('ws', `${fmt(widths.standard)} m`, 'tie');
  cell('wr', `${fmt(widths.reversed)} m`, 'safe');
  cell('wl', `${fmt(widths.log)} m`, 'safe');
  for (const [mode, id] of [['standard', 'ts'], ['reversed', 'tr'], ['log', 'tl']]) {
    const c = classifyPair(state.distance, SEP, mode, state.near, FAR);
    cell(id, c.tie ? 'NO — 同一深度值' : 'yes', c.tie ? 'tie' : 'safe');
  }
  const fix = chooseFix({ near: state.near, far: FAR, cameraClearance: 1.7, minSeparation: SEP, maxDistance: state.distance });
  const v = document.getElementById('verdict');
  if (!fix.chosen) {
    v.innerHTML = `<span class="tie">standard 在这个 near 下无法分辨 2 cm。</span>先试试提高 near，或换 reversed-Z / log depth。`;
  } else if (fix.chosen.kind === 'raise-near') {
    v.innerHTML = `<span class="safe">最便宜修法：near ${state.near.toFixed(2)} → ${fix.chosen.near.toFixed(3)} m</span>（不裁剪 1.7 m 处的几何，最坏 ${fmt(fix.chosen.worstWidth)} m，裕度 ${fix.margin.toFixed(0)}×）。`;
  } else {
    v.innerHTML = `<span class="safe">最便宜修法：${fix.chosen.kind}</span>，最坏 ${fmt(fix.chosen.worstWidth)} m，裕度 ${fix.margin.toFixed(0)}×。提高 near 需要 ${fix.candidates[0].near ? fix.candidates[0].near.toFixed(2) : '> 1.7'} m，会裁掉相机附近几何。`;
  }
  drawPlot();
}

function drawPlot() {
  const c = document.getElementById('plot');
  const g = c.getContext('2d');
  const W = c.width, H = c.height, pad = 34;
  g.clearRect(0, 0, W, H);
  const zs = chartDistances(Math.max(0.02, state.near), FAR, Math.min(FAR * 0.9, 3000), 40);
  const series = MODES.map((mode) => ({ mode, pts: zs.map((z) => ({ z, w: depthBinWidth(z, mode, state.near, FAR) })) }));
  const all = series.flatMap((s) => s.pts.map((p) => p.w));
  const lo = Math.log10(Math.max(1e-9, Math.min(...all)));
  const hi = Math.log10(Math.max(...all));
  const x = (z) => pad + ((Math.log10(z) - Math.log10(zs[0])) / (Math.log10(zs.at(-1)) - Math.log10(zs[0]))) * (W - pad - 8);
  const y = (w) => H - pad - ((Math.log10(w) - lo) / (hi - lo || 1)) * (H - pad - 12);

  g.strokeStyle = '#1c2836'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad, 12); g.lineTo(pad, H - pad); g.lineTo(W - 8, H - pad); g.stroke();
  g.strokeStyle = '#ff6b6b'; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(pad, y(SEP)); g.lineTo(W - 8, y(SEP)); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#ff6b6b'; g.font = '11px monospace'; g.fillText('2 cm 分辨率线', pad + 4, y(SEP) - 4);

  const colors = { standard: '#ff9f43', reversed: '#5ee08a', log: '#7fb3ff' };
  for (const s of series) {
    g.strokeStyle = colors[s.mode]; g.lineWidth = 2; g.beginPath();
    s.pts.forEach((p, i) => (i ? g.lineTo(x(p.z), y(p.w)) : g.moveTo(x(p.z), y(p.w))));
    g.stroke();
  }
  g.strokeStyle = '#fff'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x(state.distance), 12); g.lineTo(x(state.distance), H - pad); g.stroke();
  g.fillStyle = '#9fb4cc'; g.fillText('深度分辨率 (m, log)', pad + 4, 16);
  g.fillText(`${Math.round(zs[0])} m`, pad, H - pad + 14);
  g.fillText(`${Math.round(zs.at(-1))} m`, W - 60, H - pad + 14);
  g.fillStyle = colors.standard; g.fillText('standard', W - 200, 22);
  g.fillStyle = colors.reversed; g.fillText('reversed', W - 130, 22);
  g.fillStyle = colors.log; g.fillText('log', W - 60, 22);
}

nearEl.addEventListener('input', () => { state.near = Math.pow(10, +nearEl.value); refresh(); });
distEl.addEventListener('input', () => { state.distance = Math.pow(10, +distEl.value); refresh(); });
addEventListener('resize', () => {
  renderer.setSize(host.clientWidth, host.clientHeight);
  camera.aspect = host.clientWidth / host.clientHeight;
  camera.updateProjectionMatrix();
});

refresh();
renderer.setAnimationLoop(() => renderer.render(scene, camera));
