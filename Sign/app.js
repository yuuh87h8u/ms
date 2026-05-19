import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SkinMesh } from './skinmesh.js';

// ── Coordinate mapping ──────────────────────────────────────────────────────
const WORLD_SCALE  = 2.0;
const WORLD_Z_SCALE = 0.5;

function landmarkToVec3(lm) {
  return new THREE.Vector3(
    (lm.x - 0.5) * WORLD_SCALE,
    -(lm.y - 0.5) * WORLD_SCALE,
    -lm.z * WORLD_Z_SCALE
  );
}

// ── Three.js scene ──────────────────────────────────────────────────────────
const threeCanvas = document.getElementById('three-canvas');
const renderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const grid = new THREE.GridHelper(4, 10, 0x1e1e1e, 0x1e1e1e);
grid.position.y = -1.15;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(0, 0.2, 3.5);

const controls = new OrbitControls(camera, threeCanvas);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
keyLight.position.set(2, 4, 3);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x8899ff, 0.25);
fillLight.position.set(-2, 0, -2);
scene.add(fillLight);

// Resize handling
const rightPanel = document.getElementById('right-panel');
const ro = new ResizeObserver(() => {
  const w = rightPanel.clientWidth;
  const h = rightPanel.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
});
ro.observe(rightPanel);

// ── Skeleton (LineSegments + InstancedMesh) ─────────────────────────────────
const MAX_LINE_PAIRS = 700;
const skelPositions = new Float32Array(MAX_LINE_PAIRS * 6);
const skelGeom = new THREE.BufferGeometry();
skelGeom.setAttribute('position', new THREE.BufferAttribute(skelPositions, 3));
skelGeom.setDrawRange(0, 0);

const skelLines = new THREE.LineSegments(
  skelGeom,
  new THREE.LineBasicMaterial({ color: 0xffffff })
);

const JOINT_COUNT = 110;
const jointGeom = new THREE.SphereGeometry(0.018, 6, 6);
const jointMat  = new THREE.MeshPhongMaterial({ color: 0xcccccc });
const jointInstanced = new THREE.InstancedMesh(jointGeom, jointMat, JOINT_COUNT);
jointInstanced.frustumCulled = false;

const skelGroup = new THREE.Group();
skelGroup.add(skelLines);
skelGroup.add(jointInstanced);
scene.add(skelGroup);

// ── Skin mesh ───────────────────────────────────────────────────────────────
const skinMesh = new SkinMesh(scene, landmarkToVec3);

// ── View mode toggle ────────────────────────────────────────────────────────
const viewModeEl = document.getElementById('view-mode');
viewModeEl.addEventListener('change', () => {
  const m = viewModeEl.value;
  skelGroup.visible  = m !== 'skin';
  skinMesh.group.visible = m !== 'skeleton';
});

// ── Status helper ───────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
function setStatus(msg, active = false) {
  statusEl.textContent = msg;
  statusEl.className = active ? 'tracking' : '';
}

// ── Skeleton update ─────────────────────────────────────────────────────────
const _mat4 = new THREE.Matrix4();

function getPoseConnections() {
  // POSE_CONNECTIONS may be {start,end} objects or [a,b] arrays
  if (!window.POSE_CONNECTIONS) return [];
  return window.POSE_CONNECTIONS;
}

function getHandConnections() {
  if (!window.HAND_CONNECTIONS) return [];
  return window.HAND_CONNECTIONS;
}

function getFaceOvalConnections() {
  if (!window.FACEMESH_FACE_OVAL) return [];
  return window.FACEMESH_FACE_OVAL;
}

function pairValues(pair) {
  if (Array.isArray(pair)) return [pair[0], pair[1]];
  return [pair.start, pair.end];
}

function updateSkeleton(pose, face, lhand, rhand) {
  let off = 0;
  let jIdx = 0;
  const p = skelPositions;

  function addSeg(a, b) {
    p[off++]=a.x; p[off++]=a.y; p[off++]=a.z;
    p[off++]=b.x; p[off++]=b.y; p[off++]=b.z;
  }
  function addJoint(v, s = 1) {
    _mat4.identity();
    _mat4.setPosition(v.x, v.y, v.z);
    if (s !== 1) {
      _mat4.elements[0] = s;
      _mat4.elements[5] = s;
      _mat4.elements[10] = s;
    }
    jointInstanced.setMatrixAt(jIdx++, _mat4);
  }

  if (pose) {
    const verts = pose.map(landmarkToVec3);
    for (const pair of getPoseConnections()) {
      const [s, e] = pairValues(pair);
      if ((pose[s].visibility ?? 1) > 0.3 && (pose[e].visibility ?? 1) > 0.3) {
        addSeg(verts[s], verts[e]);
      }
    }
    for (let i = 0; i < 33; i++) {
      if ((pose[i].visibility ?? 1) > 0.3) addJoint(verts[i]);
    }
  }

  for (const hand of [lhand, rhand]) {
    if (!hand) continue;
    const verts = hand.map(landmarkToVec3);
    for (const pair of getHandConnections()) {
      const [s, e] = pairValues(pair);
      addSeg(verts[s], verts[e]);
    }
    for (const v of verts) addJoint(v, 0.55);
  }

  if (face) {
    const verts = face.map(landmarkToVec3);
    for (const pair of getFaceOvalConnections()) {
      const [s, e] = pairValues(pair);
      addSeg(verts[s], verts[e]);
    }
  }

  // Hide unused joint slots
  const hideMat = new THREE.Matrix4().setPosition(0, -999, 0);
  while (jIdx < JOINT_COUNT) jointInstanced.setMatrixAt(jIdx++, hideMat);

  skelGeom.setDrawRange(0, off / 3);
  skelGeom.attributes.position.needsUpdate = true;
  jointInstanced.instanceMatrix.needsUpdate = true;
  jointInstanced.count = JOINT_COUNT;
}

// ── 2D overlay drawing ──────────────────────────────────────────────────────
const overlayCanvas  = document.getElementById('overlay-canvas');
const overlayCtx     = overlayCanvas.getContext('2d');
const uploadOverlay  = document.getElementById('upload-overlay');
const uploadOverlayCtx = uploadOverlay.getContext('2d');

let activeOverlayCanvas = overlayCanvas;
let activeOverlayCtx    = overlayCtx;

function draw2DOverlay(results) {
  const canvas = activeOverlayCanvas;
  const ctx    = activeOverlayCtx;

  canvas.width  = canvas.clientWidth  || canvas.offsetWidth  || 640;
  canvas.height = canvas.clientHeight || canvas.offsetHeight || 480;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const mirror = activeSource === 'webcam';

  // Draw the video frame onto the canvas (reliable cross-platform, fixes black panel)
  if (results.image) {
    ctx.save();
    if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // Draw landmarks on top
  ctx.save();
  if (mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }

  if (results.poseLandmarks && window.drawConnectors && window.drawLandmarks) {
    drawConnectors(ctx, results.poseLandmarks, window.POSE_CONNECTIONS,
      { color: '#00FF00', lineWidth: 1.5 });
    drawLandmarks(ctx, results.poseLandmarks,
      { color: '#FF3333', lineWidth: 1, radius: 2 });
  }
  if (results.faceLandmarks && window.drawConnectors && window.FACEMESH_TESSELATION) {
    drawConnectors(ctx, results.faceLandmarks, window.FACEMESH_TESSELATION,
      { color: '#C0C0C040', lineWidth: 0.4 });
  }
  if (results.leftHandLandmarks && window.drawConnectors) {
    drawConnectors(ctx, results.leftHandLandmarks, window.HAND_CONNECTIONS,
      { color: '#CC0000', lineWidth: 2 });
    drawLandmarks(ctx, results.leftHandLandmarks, { color: '#FF6666', lineWidth: 1, radius: 2 });
  }
  if (results.rightHandLandmarks && window.drawConnectors) {
    drawConnectors(ctx, results.rightHandLandmarks, window.HAND_CONNECTIONS,
      { color: '#00CC00', lineWidth: 2 });
    drawLandmarks(ctx, results.rightHandLandmarks, { color: '#66FF66', lineWidth: 1, radius: 2 });
  }

  ctx.restore();
}

// ── onResults ───────────────────────────────────────────────────────────────
function onResults(results) {
  setStatus('Tracking', true);

  draw2DOverlay(results);

  const pose  = results.poseLandmarks      ?? null;
  const face  = results.faceLandmarks      ?? null;
  const lhand = results.leftHandLandmarks  ?? null;
  const rhand = results.rightHandLandmarks ?? null;

  updateSkeleton(pose, face, lhand, rhand);
  skinMesh.update(pose, face, lhand, rhand);
}

// ── MediaPipe Holistic ──────────────────────────────────────────────────────
setStatus('Loading MediaPipe…');

const holistic = new Holistic({
  locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/holistic/${f}`
});

holistic.setOptions({
  modelComplexity: 1,
  smoothLandmarks: true,
  refineFaceLandmarks: true,
  enableSegmentation: false,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
});

holistic.onResults(onResults);

// ── Input source management ─────────────────────────────────────────────────
const videoEl       = document.getElementById('input-video');
const uploadVideoEl = document.getElementById('upload-video');
const webcamView    = document.getElementById('webcam-view');
const uploadPanel   = document.getElementById('upload-panel');
const uploadPrompt  = document.getElementById('upload-prompt');
const uploadWrap    = document.getElementById('upload-video-wrap');
const fileInput     = document.getElementById('file-input');
const btnWebcam     = document.getElementById('btn-webcam');
const btnUpload     = document.getElementById('btn-upload-btn');

let activeSource = 'webcam';
let mpCamera     = null;
let uploadFrameRunning = false;

function showWebcam() {
  webcamView.style.display = 'block';
  uploadPanel.classList.remove('active');
  activeOverlayCanvas = overlayCanvas;
  activeOverlayCtx    = overlayCtx;
  btnWebcam.classList.add('active');
  btnUpload.classList.remove('active');
}

function showUpload() {
  webcamView.style.display = 'none';
  uploadPanel.classList.add('active');
  activeOverlayCanvas = uploadOverlay;
  activeOverlayCtx    = uploadOverlayCtx;
  btnUpload.classList.add('active');
  btnWebcam.classList.remove('active');
}

async function startWebcam() {
  if (activeSource === 'webcam' && mpCamera) return;
  activeSource = 'webcam';
  uploadFrameRunning = false;

  showWebcam();
  setStatus('Starting camera…');

  if (!mpCamera) {
    try {
      mpCamera = new Camera(videoEl, {
        onFrame: async () => { await holistic.send({ image: videoEl }); },
        width: 1280,
        height: 720,
      });
      await mpCamera.start();
      setStatus('Ready', true);
    } catch (err) {
      setStatus('Camera access denied');
      console.error(err);
    }
  }
}

function driveUploadVideo() {
  if (!uploadFrameRunning) return;
  if (uploadVideoEl.paused || uploadVideoEl.ended) return;

  holistic.send({ image: uploadVideoEl }).then(() => {
    if (!uploadFrameRunning) return;
    if (uploadVideoEl.requestVideoFrameCallback) {
      uploadVideoEl.requestVideoFrameCallback(driveUploadVideo);
    } else {
      requestAnimationFrame(driveUploadVideo);
    }
  }).catch(console.warn);
}

btnWebcam.addEventListener('click', startWebcam);

btnUpload.addEventListener('click', () => {
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  activeSource = 'upload';
  uploadFrameRunning = false;

  // Stop webcam
  if (mpCamera) { mpCamera.stop(); mpCamera = null; }

  showUpload();
  uploadPrompt.style.display = 'none';
  uploadWrap.style.display = 'block';

  const url = URL.createObjectURL(file);
  uploadVideoEl.src = url;
  uploadVideoEl.load();

  uploadVideoEl.addEventListener('play', () => {
    uploadFrameRunning = true;
    if (uploadVideoEl.requestVideoFrameCallback) {
      uploadVideoEl.requestVideoFrameCallback(driveUploadVideo);
    } else {
      driveUploadVideo();
    }
  }, { once: false });

  uploadVideoEl.play().catch(console.warn);
  setStatus('Video loaded', true);
});

// ── Render loop ─────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// ── Boot ─────────────────────────────────────────────────────────────────────
startWebcam();
