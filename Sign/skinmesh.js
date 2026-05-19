import * as THREE from 'three';

// Limb segments: [poseIdxA, poseIdxB, radius]
const LIMB_SEGMENTS = [
  [11, 12, 0.060], // shoulder bar
  [11, 23, 0.070], // left torso side
  [12, 24, 0.070], // right torso side
  [23, 24, 0.065], // hip bar
  [11, 13, 0.045], // L upper arm
  [13, 15, 0.038], // L forearm
  [12, 14, 0.045], // R upper arm
  [14, 16, 0.038], // R forearm
  [23, 25, 0.055], // L thigh
  [25, 27, 0.045], // L shin
  [27, 31, 0.028], // L foot
  [24, 26, 0.055], // R thigh
  [26, 28, 0.045], // R shin
  [28, 32, 0.028], // R foot
];

const JOINT_INDICES = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 0];
const JOINT_RADII  = [0.070, 0.070, 0.050, 0.050, 0.040, 0.040,
                      0.065, 0.065, 0.055, 0.055, 0.045, 0.045, 0.050];

// Finger segments: [handLmA, handLmB, radius]
const FINGER_SEGMENTS = [
  // Thumb
  [0,1,0.018],[1,2,0.016],[2,3,0.014],[3,4,0.012],
  // Index
  [0,5,0.020],[5,6,0.016],[6,7,0.013],[7,8,0.011],
  // Middle
  [0,9,0.020],[9,10,0.016],[10,11,0.013],[11,12,0.011],
  // Ring
  [0,13,0.018],[13,14,0.014],[14,15,0.012],[15,16,0.010],
  // Pinky
  [0,17,0.016],[17,18,0.012],[18,19,0.010],[19,20,0.009],
  // Palm connectors
  [5,9,0.018],[9,13,0.018],[13,17,0.016],
];

const KNUCKLE_RADII = [
  0.025, 0.018, 0.016, 0.014, 0.012,
  0.020, 0.016, 0.013, 0.011,
  0.020, 0.016, 0.013, 0.011,
  0.018, 0.014, 0.012, 0.010,
  0.016, 0.012, 0.010, 0.009,
];

// Shared helpers — avoid allocation per frame
const _up  = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function orientCylinder(mesh, A, B, radius) {
  _dir.subVectors(B, A);
  const len = _dir.length();
  if (len < 0.001) { mesh.visible = false; return; }
  _dir.normalize();
  mesh.position.copy(A).addScaledVector(_dir, len * 0.5);
  mesh.scale.set(radius, len * 0.5, radius);
  // setFromUnitVectors can be unstable when dir ≈ -up; fall back to altUp
  if (Math.abs(_dir.y) > 0.9999) {
    _quat.setFromUnitVectors(_up, _dir.dot(new THREE.Vector3(0,1,0)) > 0 ? _up : new THREE.Vector3(0,-1,0));
    // simpler: just rotate 180 around X if pointing straight down
    if (_dir.y < 0) _quat.setFromAxisAngle(new THREE.Vector3(1,0,0), Math.PI);
    else _quat.identity();
  } else {
    _quat.setFromUnitVectors(_up, _dir);
  }
  mesh.quaternion.copy(_quat);
  mesh.visible = true;
}

export class SkinMesh {
  constructor(scene, landmarkToVec3) {
    this.l2v = landmarkToVec3;
    // Face z values from MediaPipe are very small — amplify for visible 3D depth
    this.l2vFace = (lm) => {
      const v = landmarkToVec3(lm);
      v.z *= 5.0;
      return v;
    };
    this.group = new THREE.Group();
    scene.add(this.group);

    const skinMat = new THREE.MeshPhongMaterial({ color: 0xFFDBAC, shininess: 30, specular: 0x333333 });
    const faceMat = new THREE.MeshPhongMaterial({ color: 0xF0C8A0, shininess: 20, side: THREE.DoubleSide });
    const eyeWhiteMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 80 });
    const irisMat = new THREE.MeshPhongMaterial({ color: 0x2244AA, shininess: 60 });

    this._skinMat = skinMat;

    // ── Body limbs ──
    const cylGeom = new THREE.CylinderGeometry(1, 1, 2, 8);
    this.limbMeshes = LIMB_SEGMENTS.map(() => {
      const m = new THREE.Mesh(cylGeom, skinMat);
      this.group.add(m);
      return m;
    });

    // ── Body joint spheres ──
    const sphGeom = new THREE.SphereGeometry(1, 8, 6);
    this.jointSpheres = JOINT_INDICES.map(() => {
      const m = new THREE.Mesh(sphGeom, skinMat);
      this.group.add(m);
      return m;
    });

    // ── Head ──
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), skinMat);
    this.group.add(this.headMesh);

    // ── Face mesh (BufferGeometry from tesselation) ──
    this._facePositions = new Float32Array(478 * 3);
    this._faceGeom = new THREE.BufferGeometry();
    this._faceGeom.setAttribute('position', new THREE.BufferAttribute(this._facePositions, 3));
    // indices are built lazily on first update (need FACEMESH_TESSELATION global)
    this._faceIndexBuilt = false;
    this.faceMeshObj = new THREE.Mesh(this._faceGeom, faceMat);
    this.faceMeshObj.visible = false;
    this.group.add(this.faceMeshObj);

    // ── Eyeballs ──
    this.eyes = [this._makeEye(eyeWhiteMat, irisMat), this._makeEye(eyeWhiteMat, irisMat)];

    // ── Hands ──
    const smCylGeom = new THREE.CylinderGeometry(1, 1, 2, 6);
    const smSphGeom = new THREE.SphereGeometry(1, 6, 4);

    this.handSegs = [[], []];
    this.handJoints = [[], []];
    for (let h = 0; h < 2; h++) {
      for (let i = 0; i < FINGER_SEGMENTS.length; i++) {
        const m = new THREE.Mesh(smCylGeom, skinMat);
        this.group.add(m);
        this.handSegs[h].push(m);
      }
      for (let j = 0; j < 21; j++) {
        const m = new THREE.Mesh(smSphGeom, skinMat);
        this.group.add(m);
        this.handJoints[h].push(m);
      }
    }
  }

  _makeEye(whiteMat, irisMat) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), whiteMat));
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), irisMat);
    iris.position.z = 0.78;
    g.add(iris);
    this.group.add(g);
    g.visible = false;
    return g;
  }

  _buildFaceIndices() {
    // FACEMESH_TESSELATION is a global set by @mediapipe/holistic
    // Each group of 3 consecutive pairs [a,b],[b,c],[c,a] forms one triangle
    const t = window.FACEMESH_TESSELATION;
    if (!t || t.length === 0) return null;

    const indices = [];
    for (let i = 0; i + 2 < t.length; i += 3) {
      const a = t[i].start   !== undefined ? t[i].start   : t[i][0];
      const b = t[i].end     !== undefined ? t[i].end     : t[i][1];
      const c = t[i+1].end   !== undefined ? t[i+1].end   : t[i+1][1];
      indices.push(a, b, c);
    }
    return new Uint16Array(indices);
  }

  update(pose, face, lhand, rhand) {
    this._updateBody(pose, !!face);
    this._updateFace(face);
    this._updateHand(lhand, 0);
    this._updateHand(rhand, 1);
  }

  _updateBody(pose, faceActive) {
    if (!pose) {
      this.limbMeshes.forEach(m => m.visible = false);
      this.jointSpheres.forEach(m => m.visible = false);
      this.headMesh.visible = false;
      return;
    }
    const verts = pose.map(lm => this.l2v(lm));

    LIMB_SEGMENTS.forEach(([a, b, r], i) => {
      const vis = (pose[a].visibility ?? 1) > 0.3 && (pose[b].visibility ?? 1) > 0.3;
      if (!vis) { this.limbMeshes[i].visible = false; return; }
      orientCylinder(this.limbMeshes[i], verts[a], verts[b], r);
    });

    JOINT_INDICES.forEach((idx, i) => {
      const vis = (pose[idx].visibility ?? 1) > 0.3;
      this.jointSpheres[i].visible = vis;
      if (vis) {
        this.jointSpheres[i].position.copy(verts[idx]);
        this.jointSpheres[i].scale.setScalar(JOINT_RADII[i]);
      }
    });

    // Only show head sphere when face mesh is NOT active (avoids double-rendering blob)
    if (faceActive) {
      this.headMesh.visible = false;
      return;
    }

    const lEarVis = (pose[7].visibility ?? 0) > 0.2;
    const rEarVis = (pose[8].visibility ?? 0) > 0.2;
    if (lEarVis || rEarVis) {
      const lEar = verts[7];
      const rEar = verts[8];
      this.headMesh.position.copy(lEar).add(rEar).multiplyScalar(0.5);
      const r = lEar.distanceTo(rEar) * 0.60;
      this.headMesh.scale.setScalar(r > 0.01 ? r : 0.12);
      this.headMesh.visible = true;
    } else {
      this.headMesh.visible = false;
    }
  }

  _updateFace(face) {
    if (!face || face.length === 0) {
      this.faceMeshObj.visible = false;
      this.eyes.forEach(e => e.visible = false);
      return;
    }

    // Build triangle index buffer once
    if (!this._faceIndexBuilt) {
      const idx = this._buildFaceIndices();
      if (idx) {
        this._faceGeom.setIndex(new THREE.BufferAttribute(idx, 1));
        this._faceIndexBuilt = true;
      }
    }

    const p = this._facePositions;
    const count = Math.min(face.length, 478);
    for (let i = 0; i < count; i++) {
      const v = this.l2vFace(face[i]);
      p[i * 3]     = v.x;
      p[i * 3 + 1] = v.y;
      p[i * 3 + 2] = v.z;
    }
    this._faceGeom.attributes.position.needsUpdate = true;
    if (this._faceIndexBuilt) {
      this._faceGeom.computeVertexNormals();
      this.faceMeshObj.visible = true;
    }

    // Eyeballs: iris landmarks at 468 (left) and 473 (right), need 478 total
    if (face.length >= 478) {
      const lCenter = this.l2vFace(face[468]);
      const rCenter = this.l2vFace(face[473]);
      const inner = this.l2vFace(face[133]);
      const outer = this.l2vFace(face[33]);
      const eyeR = inner.distanceTo(outer) * 0.26;
      const r = eyeR > 0.005 ? eyeR : 0.030;

      this.eyes[0].position.copy(lCenter);
      this.eyes[0].scale.setScalar(r);
      this.eyes[0].visible = true;

      this.eyes[1].position.copy(rCenter);
      this.eyes[1].scale.setScalar(r);
      this.eyes[1].visible = true;
    } else {
      this.eyes.forEach(e => e.visible = false);
    }
  }

  _updateHand(hand, idx) {
    const segs = this.handSegs[idx];
    const joints = this.handJoints[idx];
    if (!hand || hand.length < 21) {
      segs.forEach(m => m.visible = false);
      joints.forEach(m => m.visible = false);
      return;
    }
    const verts = hand.map(lm => this.l2v(lm));

    FINGER_SEGMENTS.forEach(([a, b, r], i) => {
      orientCylinder(segs[i], verts[a], verts[b], r);
    });

    verts.forEach((v, i) => {
      joints[i].position.copy(v);
      joints[i].scale.setScalar(KNUCKLE_RADII[i] ?? 0.012);
      joints[i].visible = true;
    });
  }
}
