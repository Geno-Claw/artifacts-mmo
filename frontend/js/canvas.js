const PORTRAITS = {
  warrior: {
    pixels: [
      { x: 5, y: 0, c: '#607890' }, { x: 6, y: 0, c: '#607890' }, { x: 7, y: 0, c: '#607890' }, { x: 8, y: 0, c: '#607890' }, { x: 9, y: 0, c: '#607890' },
      { x: 4, y: 1, c: '#607890' }, { x: 5, y: 1, c: '#789cb8' }, { x: 6, y: 1, c: '#789cb8' }, { x: 7, y: 1, c: '#90b8d0' }, { x: 8, y: 1, c: '#789cb8' }, { x: 9, y: 1, c: '#789cb8' }, { x: 10, y: 1, c: '#607890' },
      { x: 3, y: 2, c: '#607890' }, { x: 4, y: 2, c: '#789cb8' }, { x: 5, y: 2, c: '#90b8d0' }, { x: 6, y: 2, c: '#789cb8' }, { x: 7, y: 2, c: '#90b8d0' }, { x: 8, y: 2, c: '#789cb8' }, { x: 9, y: 2, c: '#90b8d0' }, { x: 10, y: 2, c: '#789cb8' }, { x: 11, y: 2, c: '#607890' },
      { x: 2, y: 3, c: '#506878' }, { x: 3, y: 3, c: '#607890' }, { x: 4, y: 3, c: '#607890' }, { x: 5, y: 3, c: '#607890' }, { x: 6, y: 3, c: '#607890' }, { x: 7, y: 3, c: '#607890' }, { x: 8, y: 3, c: '#607890' }, { x: 9, y: 3, c: '#607890' }, { x: 10, y: 3, c: '#607890' }, { x: 11, y: 3, c: '#607890' }, { x: 12, y: 3, c: '#506878' },
      { x: 4, y: 4, c: '#e8c8a0' }, { x: 5, y: 4, c: '#e8c8a0' }, { x: 6, y: 4, c: '#f0d8b8' }, { x: 7, y: 4, c: '#f0d8b8' }, { x: 8, y: 4, c: '#f0d8b8' }, { x: 9, y: 4, c: '#e8c8a0' }, { x: 10, y: 4, c: '#e8c8a0' },
      { x: 3, y: 5, c: '#e8c8a0' }, { x: 4, y: 5, c: '#f0d8b8' }, { x: 5, y: 5, c: '#382828' }, { x: 6, y: 5, c: '#f0d8b8' }, { x: 7, y: 5, c: '#f0d8b8' }, { x: 8, y: 5, c: '#f0d8b8' }, { x: 9, y: 5, c: '#382828' }, { x: 10, y: 5, c: '#f0d8b8' }, { x: 11, y: 5, c: '#e8c8a0' },
      { x: 3, y: 6, c: '#e8c8a0' }, { x: 4, y: 6, c: '#f0d8b8' }, { x: 5, y: 6, c: '#f0d8b8' }, { x: 6, y: 6, c: '#f0d8b8' }, { x: 7, y: 6, c: '#d8b090' }, { x: 8, y: 6, c: '#f0d8b8' }, { x: 9, y: 6, c: '#f0d8b8' }, { x: 10, y: 6, c: '#f0d8b8' }, { x: 11, y: 6, c: '#e8c8a0' },
      { x: 4, y: 7, c: '#e8c8a0' }, { x: 5, y: 7, c: '#f0d8b8' }, { x: 6, y: 7, c: '#c09880' }, { x: 7, y: 7, c: '#c09880' }, { x: 8, y: 7, c: '#c09880' }, { x: 9, y: 7, c: '#f0d8b8' }, { x: 10, y: 7, c: '#e8c8a0' },
      { x: 5, y: 8, c: '#e8c8a0' }, { x: 6, y: 8, c: '#e8c8a0' }, { x: 7, y: 8, c: '#e8c8a0' }, { x: 8, y: 8, c: '#e8c8a0' }, { x: 9, y: 8, c: '#e8c8a0' },
      { x: 6, y: 9, c: '#d8b890' }, { x: 7, y: 9, c: '#d8b890' }, { x: 8, y: 9, c: '#d8b890' },
      { x: 2, y: 10, c: '#607890' }, { x: 3, y: 10, c: '#789cb8' }, { x: 4, y: 10, c: '#789cb8' }, { x: 5, y: 10, c: '#607890' }, { x: 6, y: 10, c: '#607890' }, { x: 7, y: 10, c: '#607890' }, { x: 8, y: 10, c: '#607890' }, { x: 9, y: 10, c: '#607890' }, { x: 10, y: 10, c: '#789cb8' }, { x: 11, y: 10, c: '#789cb8' }, { x: 12, y: 10, c: '#607890' },
      { x: 1, y: 11, c: '#506878' }, { x: 2, y: 11, c: '#789cb8' }, { x: 3, y: 11, c: '#90b8d0' }, { x: 4, y: 11, c: '#789cb8' }, { x: 5, y: 11, c: '#607890' }, { x: 6, y: 11, c: '#789cb8' }, { x: 7, y: 11, c: '#90b8d0' }, { x: 8, y: 11, c: '#789cb8' }, { x: 9, y: 11, c: '#607890' }, { x: 10, y: 11, c: '#789cb8' }, { x: 11, y: 11, c: '#90b8d0' }, { x: 12, y: 11, c: '#789cb8' }, { x: 13, y: 11, c: '#506878' },
      { x: 1, y: 12, c: '#506878' }, { x: 2, y: 12, c: '#607890' }, { x: 3, y: 12, c: '#789cb8' }, { x: 4, y: 12, c: '#607890' }, { x: 5, y: 12, c: '#607890' }, { x: 6, y: 12, c: '#789cb8' }, { x: 7, y: 12, c: '#c0c0c0' }, { x: 8, y: 12, c: '#789cb8' }, { x: 9, y: 12, c: '#607890' }, { x: 10, y: 12, c: '#607890' }, { x: 11, y: 12, c: '#789cb8' }, { x: 12, y: 12, c: '#607890' }, { x: 13, y: 12, c: '#506878' },
      { x: 2, y: 13, c: '#607890' }, { x: 3, y: 13, c: '#607890' }, { x: 4, y: 13, c: '#607890' }, { x: 5, y: 13, c: '#607890' }, { x: 6, y: 13, c: '#607890' }, { x: 7, y: 13, c: '#607890' }, { x: 8, y: 13, c: '#607890' }, { x: 9, y: 13, c: '#607890' }, { x: 10, y: 13, c: '#607890' }, { x: 11, y: 13, c: '#607890' }, { x: 12, y: 13, c: '#607890' },
    ]
  },
  mage: {
    pixels: [
      { x: 7, y: 0, c: '#584078' },
      { x: 6, y: 1, c: '#584078' }, { x: 7, y: 1, c: '#7858a0' }, { x: 8, y: 1, c: '#584078' },
      { x: 5, y: 2, c: '#584078' }, { x: 6, y: 2, c: '#7858a0' }, { x: 7, y: 2, c: '#9070b8' }, { x: 8, y: 2, c: '#7858a0' }, { x: 9, y: 2, c: '#584078' },
      { x: 2, y: 3, c: '#483068' }, { x: 3, y: 3, c: '#584078' }, { x: 4, y: 3, c: '#584078' }, { x: 5, y: 3, c: '#7858a0' }, { x: 6, y: 3, c: '#7858a0' }, { x: 7, y: 3, c: '#f8e060' }, { x: 8, y: 3, c: '#7858a0' }, { x: 9, y: 3, c: '#7858a0' }, { x: 10, y: 3, c: '#584078' }, { x: 11, y: 3, c: '#584078' }, { x: 12, y: 3, c: '#483068' },
      { x: 3, y: 4, c: '#c0c0d0' }, { x: 4, y: 4, c: '#e8c8a0' }, { x: 5, y: 4, c: '#f0d8b8' }, { x: 6, y: 4, c: '#f0d8b8' }, { x: 7, y: 4, c: '#f0d8b8' }, { x: 8, y: 4, c: '#f0d8b8' }, { x: 9, y: 4, c: '#f0d8b8' }, { x: 10, y: 4, c: '#e8c8a0' }, { x: 11, y: 4, c: '#c0c0d0' },
      { x: 3, y: 5, c: '#c0c0d0' }, { x: 4, y: 5, c: '#f0d8b8' }, { x: 5, y: 5, c: '#382858' }, { x: 6, y: 5, c: '#f0d8b8' }, { x: 7, y: 5, c: '#f0d8b8' }, { x: 8, y: 5, c: '#f0d8b8' }, { x: 9, y: 5, c: '#382858' }, { x: 10, y: 5, c: '#f0d8b8' }, { x: 11, y: 5, c: '#c0c0d0' },
      { x: 3, y: 6, c: '#c0c0d0' }, { x: 4, y: 6, c: '#f0d8b8' }, { x: 5, y: 6, c: '#f0d8b8' }, { x: 6, y: 6, c: '#f0d8b8' }, { x: 7, y: 6, c: '#d8b090' }, { x: 8, y: 6, c: '#f0d8b8' }, { x: 9, y: 6, c: '#f0d8b8' }, { x: 10, y: 6, c: '#f0d8b8' }, { x: 11, y: 6, c: '#c0c0d0' },
      { x: 4, y: 7, c: '#e8c8a0' }, { x: 5, y: 7, c: '#f0d8b8' }, { x: 6, y: 7, c: '#b88880' }, { x: 7, y: 7, c: '#f0d8b8' }, { x: 8, y: 7, c: '#b88880' }, { x: 9, y: 7, c: '#f0d8b8' }, { x: 10, y: 7, c: '#e8c8a0' },
      { x: 5, y: 8, c: '#e8c8a0' }, { x: 6, y: 8, c: '#e8c8a0' }, { x: 7, y: 8, c: '#e8c8a0' }, { x: 8, y: 8, c: '#e8c8a0' }, { x: 9, y: 8, c: '#e8c8a0' },
      { x: 5, y: 9, c: '#c0c0d0' }, { x: 6, y: 9, c: '#d8b890' }, { x: 7, y: 9, c: '#d8b890' }, { x: 8, y: 9, c: '#d8b890' }, { x: 9, y: 9, c: '#c0c0d0' },
      { x: 3, y: 10, c: '#584078' }, { x: 4, y: 10, c: '#7858a0' }, { x: 5, y: 10, c: '#584078' }, { x: 6, y: 10, c: '#584078' }, { x: 7, y: 10, c: '#584078' }, { x: 8, y: 10, c: '#584078' }, { x: 9, y: 10, c: '#584078' }, { x: 10, y: 10, c: '#7858a0' }, { x: 11, y: 10, c: '#584078' },
      { x: 2, y: 11, c: '#483068' }, { x: 3, y: 11, c: '#7858a0' }, { x: 4, y: 11, c: '#9070b8' }, { x: 5, y: 11, c: '#7858a0' }, { x: 6, y: 11, c: '#584078' }, { x: 7, y: 11, c: '#f8e060' }, { x: 8, y: 11, c: '#584078' }, { x: 9, y: 11, c: '#7858a0' }, { x: 10, y: 11, c: '#9070b8' }, { x: 11, y: 11, c: '#7858a0' }, { x: 12, y: 11, c: '#483068' },
      { x: 2, y: 12, c: '#483068' }, { x: 3, y: 12, c: '#584078' }, { x: 4, y: 12, c: '#7858a0' }, { x: 5, y: 12, c: '#584078' }, { x: 6, y: 12, c: '#7858a0' }, { x: 7, y: 12, c: '#9070b8' }, { x: 8, y: 12, c: '#7858a0' }, { x: 9, y: 12, c: '#584078' }, { x: 10, y: 12, c: '#7858a0' }, { x: 11, y: 12, c: '#584078' }, { x: 12, y: 12, c: '#483068' },
      { x: 3, y: 13, c: '#584078' }, { x: 4, y: 13, c: '#584078' }, { x: 5, y: 13, c: '#584078' }, { x: 6, y: 13, c: '#584078' }, { x: 7, y: 13, c: '#584078' }, { x: 8, y: 13, c: '#584078' }, { x: 9, y: 13, c: '#584078' }, { x: 10, y: 13, c: '#584078' }, { x: 11, y: 13, c: '#584078' },
    ]
  },
  gatherer: {
    pixels: [
      { x: 5, y: 0, c: '#3a6838' }, { x: 6, y: 0, c: '#3a6838' }, { x: 7, y: 0, c: '#3a6838' }, { x: 8, y: 0, c: '#3a6838' }, { x: 9, y: 0, c: '#3a6838' },
      { x: 4, y: 1, c: '#3a6838' }, { x: 5, y: 1, c: '#508848' }, { x: 6, y: 1, c: '#508848' }, { x: 7, y: 1, c: '#60a058' }, { x: 8, y: 1, c: '#508848' }, { x: 9, y: 1, c: '#508848' }, { x: 10, y: 1, c: '#3a6838' },
      { x: 3, y: 2, c: '#3a6838' }, { x: 4, y: 2, c: '#508848' }, { x: 5, y: 2, c: '#60a058' }, { x: 6, y: 2, c: '#508848' }, { x: 7, y: 2, c: '#60a058' }, { x: 8, y: 2, c: '#508848' }, { x: 9, y: 2, c: '#60a058' }, { x: 10, y: 2, c: '#508848' }, { x: 11, y: 2, c: '#3a6838' },
      { x: 3, y: 3, c: '#2a5028' }, { x: 4, y: 3, c: '#3a6838' }, { x: 5, y: 3, c: '#3a6838' }, { x: 6, y: 3, c: '#3a6838' }, { x: 7, y: 3, c: '#3a6838' }, { x: 8, y: 3, c: '#3a6838' }, { x: 9, y: 3, c: '#3a6838' }, { x: 10, y: 3, c: '#3a6838' }, { x: 11, y: 3, c: '#2a5028' },
      { x: 3, y: 4, c: '#3a6838' }, { x: 4, y: 4, c: '#e0c098' }, { x: 5, y: 4, c: '#f0d8b8' }, { x: 6, y: 4, c: '#f0d8b8' }, { x: 7, y: 4, c: '#f0d8b8' }, { x: 8, y: 4, c: '#f0d8b8' }, { x: 9, y: 4, c: '#f0d8b8' }, { x: 10, y: 4, c: '#e0c098' }, { x: 11, y: 4, c: '#3a6838' },
      { x: 3, y: 5, c: '#3a6838' }, { x: 4, y: 5, c: '#f0d8b8' }, { x: 5, y: 5, c: '#283818' }, { x: 6, y: 5, c: '#f0d8b8' }, { x: 7, y: 5, c: '#f0d8b8' }, { x: 8, y: 5, c: '#f0d8b8' }, { x: 9, y: 5, c: '#283818' }, { x: 10, y: 5, c: '#f0d8b8' }, { x: 11, y: 5, c: '#3a6838' },
      { x: 4, y: 6, c: '#f0d8b8' }, { x: 5, y: 6, c: '#f0d8b8' }, { x: 6, y: 6, c: '#f0d8b8' }, { x: 7, y: 6, c: '#d8b090' }, { x: 8, y: 6, c: '#f0d8b8' }, { x: 9, y: 6, c: '#f0d8b8' }, { x: 10, y: 6, c: '#f0d8b8' },
      { x: 4, y: 7, c: '#e8c8a0' }, { x: 5, y: 7, c: '#f0d8b8' }, { x: 6, y: 7, c: '#c09880' }, { x: 7, y: 7, c: '#c09880' }, { x: 8, y: 7, c: '#c09880' }, { x: 9, y: 7, c: '#f0d8b8' }, { x: 10, y: 7, c: '#e8c8a0' },
      { x: 5, y: 8, c: '#e8c8a0' }, { x: 6, y: 8, c: '#e8c8a0' }, { x: 7, y: 8, c: '#e8c8a0' }, { x: 8, y: 8, c: '#e8c8a0' }, { x: 9, y: 8, c: '#e8c8a0' },
      { x: 5, y: 9, c: '#a07848' }, { x: 6, y: 9, c: '#d8b890' }, { x: 7, y: 9, c: '#d8b890' }, { x: 8, y: 9, c: '#d8b890' }, { x: 9, y: 9, c: '#a07848' },
      { x: 3, y: 10, c: '#3a6838' }, { x: 4, y: 10, c: '#508848' }, { x: 5, y: 10, c: '#3a6838' }, { x: 6, y: 10, c: '#3a6838' }, { x: 7, y: 10, c: '#3a6838' }, { x: 8, y: 10, c: '#3a6838' }, { x: 9, y: 10, c: '#3a6838' }, { x: 10, y: 10, c: '#508848' }, { x: 11, y: 10, c: '#3a6838' },
      { x: 2, y: 11, c: '#2a5028' }, { x: 3, y: 11, c: '#508848' }, { x: 4, y: 11, c: '#60a058' }, { x: 5, y: 11, c: '#508848' }, { x: 6, y: 11, c: '#3a6838' }, { x: 7, y: 11, c: '#a07848' }, { x: 8, y: 11, c: '#3a6838' }, { x: 9, y: 11, c: '#508848' }, { x: 10, y: 11, c: '#60a058' }, { x: 11, y: 11, c: '#508848' }, { x: 12, y: 11, c: '#2a5028' },
      { x: 2, y: 12, c: '#2a5028' }, { x: 3, y: 12, c: '#3a6838' }, { x: 4, y: 12, c: '#508848' }, { x: 5, y: 12, c: '#3a6838' }, { x: 6, y: 12, c: '#508848' }, { x: 7, y: 12, c: '#60a058' }, { x: 8, y: 12, c: '#508848' }, { x: 9, y: 12, c: '#3a6838' }, { x: 10, y: 12, c: '#508848' }, { x: 11, y: 12, c: '#3a6838' }, { x: 12, y: 12, c: '#2a5028' },
      { x: 3, y: 13, c: '#3a6838' }, { x: 4, y: 13, c: '#3a6838' }, { x: 5, y: 13, c: '#3a6838' }, { x: 6, y: 13, c: '#3a6838' }, { x: 7, y: 13, c: '#3a6838' }, { x: 8, y: 13, c: '#3a6838' }, { x: 9, y: 13, c: '#3a6838' }, { x: 10, y: 13, c: '#3a6838' }, { x: 11, y: 13, c: '#3a6838' },
    ]
  }
};

/* ==============================================================
   DRAW PORTRAIT ON CANVAS — paper-colored background
   ============================================================== */
function drawPortrait(canvas, type) {
  const size = 14;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // Warm washi paper background
  ctx.fillStyle = '#ede4d4';
  ctx.fillRect(0, 0, size, size);

  const data = PORTRAITS[type];
  if (!data) return;
  data.pixels.forEach(p => {
    ctx.fillStyle = p.c;
    ctx.fillRect(p.x, p.y, 1, 1);
  });
}

/* ==============================================================
   DRAW CHERRY BRANCH ON CANVAS — sumi-e brushy style
   Variable stroke width to simulate brush pressure
   ============================================================== */
function drawCherryBranch(canvas) {
  const w = 280;
  const h = 40;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, w, h);

  // Branch path — a gentle curve from left to right
  const branchPoints = [
    [0, 24], [20, 22], [40, 18], [60, 16], [80, 15], [100, 16],
    [120, 18], [140, 17], [160, 14], [180, 12], [200, 13],
    [220, 15], [240, 18], [260, 20], [280, 22]
  ];

  // Brush pressure map — width varies along the branch (1-3px)
  // Thicker at start (brush loaded with ink), thins out, thickens again
  const pressureMap = [3, 3, 2, 2, 3, 2, 2, 1, 2, 3, 2, 2, 1, 1, 1];

  // Draw branch with variable width — sumi-e brush simulation
  for (let i = 0; i < branchPoints.length - 1; i++) {
    const [x1, y1] = branchPoints[i];
    const [x2, y2] = branchPoints[i + 1];
    const thickness = pressureMap[i] || 2;
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));

    for (let s = 0; s <= steps; s++) {
      const t = steps === 0 ? 0 : s / steps;
      const x = Math.round(x1 + (x2 - x1) * t);
      const y = Math.round(y1 + (y2 - y1) * t);

      // Vary ink darkness along stroke — like real ink wash
      const inkDark = Math.random() > 0.7 ? '#382c28' : '#483830';
      ctx.fillStyle = inkDark;
      ctx.fillRect(x, y, thickness, thickness);

      // Add slight ink bleed on thicker strokes
      if (thickness >= 3 && Math.random() > 0.8) {
        ctx.fillStyle = 'rgba(56, 44, 40, 0.3)';
        ctx.fillRect(x - 1, y + thickness, 1, 1);
      }
    }
  }

  // Sub-branches — thinner, like light brush strokes
  const subBranches = [
    [[60, 16], [50, 8], [45, 4]],
    [[120, 18], [130, 10], [135, 6]],
    [[180, 12], [170, 6], [165, 2]],
    [[220, 15], [230, 8], [235, 5]],
    [[100, 16], [95, 10]],
    [[160, 14], [155, 8]],
  ];

  subBranches.forEach(branch => {
    for (let i = 0; i < branch.length - 1; i++) {
      const [x1, y1] = branch[i];
      const [x2, y2] = branch[i + 1];
      const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        const x = Math.round(x1 + (x2 - x1) * t);
        const y = Math.round(y1 + (y2 - y1) * t);
        // Thin sub-branches fade to lighter ink
        const alpha = 1.0 - (t * 0.4);
        ctx.fillStyle = `rgba(72, 56, 48, ${alpha})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  });

  // Blossoms — mix of pink AND ink-wash gray blossoms
  const blossomPositions = [
    [45, 3], [48, 5], [42, 6],
    [130, 6], [133, 8], [127, 9], [135, 4],
    [165, 1], [168, 3], [162, 4], [170, 5],
    [230, 4], [233, 6], [227, 7], [235, 3],
    [95, 8], [92, 10], [98, 9],
    [155, 6], [152, 8], [158, 7],
  ];

  const pinkColors = ['#d88898', '#e8a8b0', '#c87888', '#d89098', '#e0b0b8'];
  const grayColors = ['#a09890', '#b8b0a8', '#908880', '#988e84', '#a8a098'];

  blossomPositions.forEach(([bx, by], idx) => {
    // Every 3rd blossom is ink-wash gray
    const isGray = idx % 3 === 2;
    const colors = isGray ? grayColors : pinkColors;

    const offsets = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
    offsets.forEach(([dx, dy], i) => {
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(bx + dx * 2, by + dy * 2, 2, 2);
    });
    // Center dot — golden for pink, dark for gray
    ctx.fillStyle = isGray ? '#685848' : '#c8a850';
    ctx.fillRect(bx, by, 1, 1);
  });

  // Ink splatter marks near branch — decorative
  const splatters = [
    [30, 28], [75, 20], [145, 22], [210, 18], [250, 25]
  ];
  splatters.forEach(([sx, sy]) => {
    ctx.fillStyle = 'rgba(42, 36, 32, 0.12)';
    ctx.fillRect(sx, sy, 1, 1);
    if (Math.random() > 0.5) {
      ctx.fillRect(sx + 2, sy + 1, 1, 1);
    }
    if (Math.random() > 0.5) {
      ctx.fillRect(sx - 1, sy + 2, 1, 1);
    }
  });
}

/* ==============================================================
   FLOATING PETALS + INK DROPS
   ============================================================== */
function createPetals() {
  const container = document.getElementById('petalsContainer');

  // Pink petal colors (ink-wash muted pinks)
  const petalColors = ['#d88898', '#e8a8b0', '#c87888', '#d89098', '#e0b0b8'];
  // Ink drop colors
  const inkColors = ['rgba(42, 36, 32, 0.3)', 'rgba(42, 36, 32, 0.25)', 'rgba(42, 36, 32, 0.2)', 'rgba(56, 44, 40, 0.25)'];

  const petalCount = 20;
  const inkCount = 8;

  // Pink petals
  for (let i = 0; i < petalCount; i++) {
    const petal = document.createElement('div');
    petal.className = 'petal petal--blossom';
    const size = Math.random() > 0.5 ? 4 : 3;
    petal.style.width = size + 'px';
    petal.style.height = size + 'px';
    petal.style.backgroundColor = petalColors[Math.floor(Math.random() * petalColors.length)];
    petal.style.left = Math.random() * 100 + '%';
    petal.style.top = -10 + 'px';
    petal.style.animationDuration = (8 + Math.random() * 12) + 's';
    petal.style.animationDelay = (Math.random() * 15) + 's';
    container.appendChild(petal);
  }

  // Ink drops — smaller, darker, round
  for (let i = 0; i < inkCount; i++) {
    const drop = document.createElement('div');
    drop.className = 'petal petal--ink';
    drop.style.width = '2px';
    drop.style.height = '2px';
    drop.style.backgroundColor = inkColors[Math.floor(Math.random() * inkColors.length)];
    drop.style.left = Math.random() * 100 + '%';
    drop.style.top = -10 + 'px';
    drop.style.animationDuration = (10 + Math.random() * 14) + 's';
    drop.style.animationDelay = (Math.random() * 18) + 's';
    container.appendChild(drop);
  }
}
