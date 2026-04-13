// === Touch → Mouse (soporte iPad/móvil) ===
// Traduce eventos touch a mouse SOLO en el área del teclado/dibujo.
// Los controles nativos (botones, sliders, selects) funcionan con touch normal.
(function() {
  let currentTarget = null;
  let isSyntheticTouch = false;

  // Elementos que deben usar su comportamiento touch nativo
  function isNativeControl(el) {
    if (!el) return true;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
        tag === 'LABEL' || tag === 'OPTION' || tag === 'TEXTAREA') return true;
    if (el.closest('.controls') || el.closest('.right-panel') ||
        el.closest('#speedPopup') || el.closest('#creditos')) return true;
    if (el.id === 'collapseLeftButton' || el.id === 'collapseRightButton') return true;
    return false;
  }

  function touchToMouse(touchEvent, mouseType) {
    const touch = touchEvent.changedTouches[0];
    const target = mouseType === 'mousedown'
      ? document.elementFromPoint(touch.clientX, touch.clientY) || touch.target
      : currentTarget || touch.target;

    // Si es un control nativo, dejar que el touch funcione normalmente
    if (mouseType === 'mousedown' && isNativeControl(target)) {
      isSyntheticTouch = false;
      return; // No interceptar
    }
    if (!isSyntheticTouch && mouseType !== 'mousedown') return;

    if (mouseType === 'mousedown') {
      currentTarget = target;
      isSyntheticTouch = true;
    }
    if (mouseType === 'mouseup') {
      const leaveEvent = new MouseEvent('mouseleave', {
        bubbles: false, cancelable: true, view: window,
        clientX: touch.clientX, clientY: touch.clientY
      });
      currentTarget && currentTarget.dispatchEvent(leaveEvent);
      currentTarget = null;
      isSyntheticTouch = false;
    }

    const mouseEvent = new MouseEvent(mouseType, {
      bubbles: true, cancelable: true, view: window,
      clientX: touch.clientX, clientY: touch.clientY,
      screenX: touch.screenX, screenY: touch.screenY,
      button: 0, buttons: mouseType === 'mouseup' ? 0 : 1
    });
    target.dispatchEvent(mouseEvent);
    touchEvent.preventDefault();
  }

  document.addEventListener('touchstart', (e) => touchToMouse(e, 'mousedown'), { passive: false });
  document.addEventListener('touchmove', (e) => touchToMouse(e, 'mousemove'), { passive: false });
  document.addEventListener('touchend', (e) => touchToMouse(e, 'mouseup'), { passive: false });
  document.addEventListener('touchcancel', (e) => touchToMouse(e, 'mouseup'), { passive: false });

  // Ocultar cursor personalizado en dispositivos táctiles
  if ('ontouchstart' in window) {
    document.documentElement.classList.add('touch-device');
  }
})();

let audioContext;
let whiteAudioBuffer;
let blackAudioBuffer;
const activeSources = {};
const keys = {};
const whiteHeldNotes = new Set();
const blackHeldNotes = new Set();

let baseFrequency = 440;
let octave = 4;
let waveform = 'sine';
let whiteHoldEnabled = false;
let blackHoldEnabled = false;
let whiteVolume = 1;
let blackVolume = 1;
let loopVolume = 1; // Volumen inicial para los loops

// Velocidades de teclas (multiplicador)
let whiteKeySpeed = 1;
let blackKeySpeed = 1;

// Variables para el efecto ChromaVerb
let reverbNode = null;
let isChromaVerbActive = false;

// Variables para grabación y loops
let recorder;
let recordingGain = null;
let isRecording = false;
let recordedChunks = [];
let loops = [];
const activeLoops = {};
let masterGain = null;

// Variables para el dibujo de formas
let isDrawing = false;
let startX, startY;
let currentLineData = null;
let lines = [];
const maxLines = 20;
let selectedLine = null;
let drawingMode = 'line'; // 'line', 'freehand', 'circle', 'square', 'triangle', 'pentagon'

const SVG_NS = 'http://www.w3.org/2000/svg';

// Crear el cursor personalizado
const customCursor = document.createElement('div');
customCursor.classList.add('custom-cursor');
document.body.appendChild(customCursor);

// Seguir el movimiento del mouse
document.addEventListener('mousemove', (e) => {
  customCursor.style.left = `${e.clientX}px`;
  customCursor.style.top = `${e.clientY}px`;
});

// Ocultar el cursor personalizado sobre los controles
const controls = document.querySelector('.controls');
controls.addEventListener('mouseenter', () => {
  customCursor.style.display = 'none';
});
controls.addEventListener('mouseleave', () => {
  customCursor.style.display = 'block';
});

// Ocultar el cursor personalizado sobre las ventanas de selección
const lineSelectionWindow = document.getElementById('lineSelectionWindow');
lineSelectionWindow.addEventListener('mouseenter', () => {
  customCursor.style.display = 'none';
});
lineSelectionWindow.addEventListener('mouseleave', () => {
  customCursor.style.display = 'block';
});

const loopBankWindow = document.getElementById('loopBankWindow');
loopBankWindow.addEventListener('mouseenter', () => {
  customCursor.style.display = 'none';
});
loopBankWindow.addEventListener('mouseleave', () => {
  customCursor.style.display = 'block';
});

// === Cambio añadido: Referencias a los botones de colapsar para verificar clics ===
// Referencias a los botones de colapsar
const collapseLeftButton = document.getElementById('collapseLeftButton');
const collapseRightButton = document.getElementById('collapseRightButton');

// === Helpers para generar puntos de formas geométricas ===

function generateEllipsePoints(cx, cy, rx, ry, segments) {
  const pts = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return pts;
}

function generateRegularPolygonPoints(cx, cy, rx, ry, sides) {
  const pts = [];
  const offset = -Math.PI / 2; // Empezar desde arriba
  for (let i = 0; i < sides; i++) {
    const angle = offset + (i / sides) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
  }
  return pts;
}

function constrainProportional(startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const size = Math.min(Math.abs(dx), Math.abs(dy));
  return {
    endX: startX + size * Math.sign(dx),
    endY: startY + size * Math.sign(dy)
  };
}

function pointsToSvgString(points) {
  return points.map(p => `${p[0]},${p[1]}`).join(' ');
}

// === Crear elemento SVG según el tipo ===

function createSvgShape(type) {
  let el;
  switch (type) {
    case 'line':
      el = document.createElementNS(SVG_NS, 'line');
      break;
    case 'freehand':
      el = document.createElementNS(SVG_NS, 'polyline');
      break;
    case 'circle':
      el = document.createElementNS(SVG_NS, 'ellipse');
      break;
    default: // square, triangle, pentagon
      el = document.createElementNS(SVG_NS, 'polygon');
      break;
  }
  el.classList.add('drawing-shape');
  return el;
}

// === Actualizar SVG durante el dibujo ===

function updateShapeSvg(data, endX, endY, shiftKey) {
  const el = data.element;
  let ex = endX, ey = endY;

  switch (data.type) {
    case 'line':
      el.setAttribute('x1', data.x1);
      el.setAttribute('y1', data.y1);
      el.setAttribute('x2', ex);
      el.setAttribute('y2', ey);
      data.points = [[data.x1, data.y1], [ex, ey]];
      data.closed = false;
      break;

    case 'freehand': {
      const lastPt = data.points[data.points.length - 1];
      const dx = ex - lastPt[0];
      const dy = ey - lastPt[1];
      if (dx * dx + dy * dy >= 25) { // mínimo 5px entre puntos
        data.points.push([ex, ey]);
      }
      el.setAttribute('points', pointsToSvgString(data.points));
      data.closed = false;
      break;
    }

    case 'circle': {
      if (shiftKey) {
        const c = constrainProportional(startX, startY, ex, ey);
        ex = c.endX; ey = c.endY;
      }
      const cx = (data.x1 + ex) / 2;
      const cy = (data.y1 + ey) / 2;
      const rx = Math.abs(ex - data.x1) / 2;
      const ry = Math.abs(ey - data.y1) / 2;
      el.setAttribute('cx', cx);
      el.setAttribute('cy', cy);
      el.setAttribute('rx', rx);
      el.setAttribute('ry', ry);
      data.points = generateEllipsePoints(cx, cy, rx, ry, 36);
      data.closed = true;
      break;
    }

    case 'square': {
      if (shiftKey) {
        const c = constrainProportional(startX, startY, ex, ey);
        ex = c.endX; ey = c.endY;
      }
      const x1 = Math.min(data.x1, ex), y1 = Math.min(data.y1, ey);
      const x2 = Math.max(data.x1, ex), y2 = Math.max(data.y1, ey);
      data.points = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
      el.setAttribute('points', pointsToSvgString(data.points));
      data.closed = true;
      break;
    }

    case 'triangle': {
      if (shiftKey) {
        const c = constrainProportional(startX, startY, ex, ey);
        ex = c.endX; ey = c.endY;
      }
      const cx = (data.x1 + ex) / 2;
      const cy = (data.y1 + ey) / 2;
      const rx = Math.abs(ex - data.x1) / 2;
      const ry = Math.abs(ey - data.y1) / 2;
      data.points = generateRegularPolygonPoints(cx, cy, rx, ry, 3);
      el.setAttribute('points', pointsToSvgString(data.points));
      data.closed = true;
      break;
    }

    case 'pentagon': {
      if (shiftKey) {
        const c = constrainProportional(startX, startY, ex, ey);
        ex = c.endX; ey = c.endY;
      }
      const cx = (data.x1 + ex) / 2;
      const cy = (data.y1 + ey) / 2;
      const rx = Math.abs(ex - data.x1) / 2;
      const ry = Math.abs(ey - data.y1) / 2;
      data.points = generateRegularPolygonPoints(cx, cy, rx, ry, 5);
      el.setAttribute('points', pointsToSvgString(data.points));
      data.closed = true;
      break;
    }
  }
}

// === Eventos de dibujo ===

const drawingSvg = document.getElementById('drawingSvg');

// Iniciar el dibujo solo si se hace clic en el fondo
document.addEventListener('mousedown', (e) => {
  if (
    e.target === collapseLeftButton ||
    e.target === collapseRightButton
  ) {
    return;
  }

  if (
    e.button === 0 &&
    !isDrawing &&
    lines.length < maxLines &&
    !e.target.closest('.controls') &&
    !e.target.closest('.selection-window') &&
    !e.target.closest('.right-panel') &&
    !e.target.closest('.key')
  ) {
    isDrawing = true;
    startX = e.clientX;
    startY = e.clientY;

    const el = createSvgShape(drawingMode);
    drawingSvg.appendChild(el);

    currentLineData = {
      element: el,
      type: drawingMode,
      x1: startX,
      y1: startY,
      points: [[startX, startY]],
      closed: false
    };

    // Inicializar SVG según tipo
    if (drawingMode === 'line') {
      el.setAttribute('x1', startX);
      el.setAttribute('y1', startY);
      el.setAttribute('x2', startX);
      el.setAttribute('y2', startY);
      currentLineData.points = [[startX, startY], [startX, startY]];
    } else if (drawingMode === 'freehand') {
      el.setAttribute('points', `${startX},${startY}`);
      el.setAttribute('fill', 'none');
    }

    lines.push(currentLineData);
    updateLineList();
  }
});

// Actualizar la forma mientras se arrastra
document.addEventListener('mousemove', (e) => {
  if (isDrawing && currentLineData) {
    updateShapeSvg(currentLineData, e.clientX, e.clientY, e.shiftKey);
  }
});

// Detener el dibujo
document.addEventListener('mouseup', (e) => {
  if (e.button === 0 && isDrawing) {
    // Eliminar formas demasiado pequeñas (clics accidentales)
    if (currentLineData) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.sqrt(dx * dx + dy * dy) < 5) {
        currentLineData.element.remove();
        lines = lines.filter(l => l !== currentLineData);
        updateLineList();
      }
    }
    isDrawing = false;
    currentLineData = null;
  }
});

// === Selección y gestión de formas ===

function selectLine(lineData) {
  if (selectedLine) {
    selectedLine.element.classList.remove('selected');
  }
  selectedLine = lineData;
  selectedLine.element.classList.add('selected');
}

const shapeNames = {
  line: 'Línea',
  freehand: 'Trazo',
  circle: 'Círculo',
  square: 'Cuadrado',
  triangle: 'Triángulo',
  pentagon: 'Pentágono'
};

function updateLineList() {
  const lineList = document.getElementById('lineList');
  lineList.innerHTML = '';

  lines.forEach((line, index) => {
    const listItem = document.createElement('li');
    listItem.textContent = `${shapeNames[line.type] || 'Forma'} ${index + 1}`;
    listItem.addEventListener('click', () => {
      selectLine(line);
    });
    lineList.appendChild(listItem);
  });
}

function deleteSelectedLine() {
  if (selectedLine) {
    selectedLine.element.remove();
    lines = lines.filter(line => line !== selectedLine);
    selectedLine = null;
    updateLineList();
  }
}

function deleteAllLines() {
  lines.forEach(line => line.element.remove());
  lines = [];
  selectedLine = null;
  updateLineList();
}

// Mostrar/ocultar la ventana de selección de líneas
const eraserButton = document.getElementById('eraserButton');
eraserButton.addEventListener('click', () => {
  lineSelectionWindow.style.display = lineSelectionWindow.style.display === 'block' ? 'none' : 'block';
});

document.getElementById('deleteSelectedButton').addEventListener('click', () => {
  deleteSelectedLine();
});

document.getElementById('deleteAllButton').addEventListener('click', () => {
  deleteAllLines();
});

// === Selector de herramienta de dibujo ===

document.querySelectorAll('.draw-tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelector('.draw-tool-btn.active').classList.remove('active');
    btn.classList.add('active');
    drawingMode = btn.dataset.tool;
  });
});

// === Detección de colisiones unificada (funciona con todas las formas) ===

function detectCollision(keyElement, shapeData) {
  const keyRect = keyElement.getBoundingClientRect();
  const keyCenterX = keyRect.left + keyRect.width / 2;
  const keyCenterY = keyRect.top + keyRect.height / 2;
  const keyRadius = Math.min(keyRect.width, keyRect.height) / 2;
  const threshold = keyRadius + 5;

  const points = shapeData.points;
  if (!points || points.length < 2) return false;

  const segmentCount = shapeData.closed ? points.length : points.length - 1;

  for (let i = 0; i < segmentCount; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];

    const A = keyCenterX - x1;
    const B = keyCenterY - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    const lenSq = C * C + D * D;
    if (lenSq === 0) continue;

    const param = Math.max(0, Math.min(1, (A * C + B * D) / lenSq));
    const nearestX = x1 + param * C;
    const nearestY = y1 + param * D;
    const dx = keyCenterX - nearestX;
    const dy = keyCenterY - nearestY;

    if (dx * dx + dy * dy <= threshold * threshold) return true;
  }

  return false;
}

// Función para verificar colisiones y reproducir sonidos
function checkCollisions() {
  Object.keys(keys).forEach((key) => {
    if (key === 'semicolon') return; // Wolf key no colisiona
    const keyData = keys[key];
    const keyElement = keyData.element;
    const note = keyToNote[key];
    const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
    const holdEnabled = isBlackKey ? blackHoldEnabled : whiteHoldEnabled;
    const heldNotes = isBlackKey ? blackHeldNotes : whiteHeldNotes;

    const isColliding = lines.some(line => detectCollision(keyElement, line));

    if (!keyData.isPressed) {
      if (isColliding && !activeSources[note]) {
        playSound(note, holdEnabled);
        keyElement.classList.add('pressed');
        if (holdEnabled) {
          heldNotes.add(note);
        }
      } else if (!isColliding && activeSources[note] && !keyData.isManual && !heldNotes.has(note)) {
        stopSound(note);
        keyElement.classList.remove('pressed');
      }
    }
  });

  requestAnimationFrame(checkCollisions);
}

// Iniciar la detección de colisiones
checkCollisions();

// Inicializar AudioContext
function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.connect(audioContext.destination);
  }
}

// Crear efecto ChromaVerb (reverb de alta calidad)
function createReverb() {
  if (!audioContext) {
    initAudioContext();
  }

  reverbNode = audioContext.createConvolver();
  const sampleRate = audioContext.sampleRate;
  const length = sampleRate * 1.5;
  const impulse = audioContext.createBuffer(2, length, sampleRate);
  const impulseL = impulse.getChannelData(0);
  const impulseR = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const decay = Math.exp(-i / (sampleRate * 0.5));
    impulseL[i] = (Math.random() * 2 - 1) * decay * 0.2;
    impulseR[i] = (Math.random() * 2 - 1) * decay * 0.2;
  }

  reverbNode.buffer = impulse;
  const reverbGain = audioContext.createGain();
  reverbGain.gain.value = 0.5;
  reverbNode.connect(reverbGain);
  reverbGain.connect(masterGain);

  return { reverbNode, reverbGain };
}

// Pre-procesar sample: aplicar micro fade-in/out para eliminar clicks de discontinuidad
function preprocessSample(buffer) {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  // 512 samples (~11ms a 44100Hz) — imperceptible pero elimina clicks
  const fadeSamples = Math.min(512, Math.floor(buffer.length / 4));

  const newBuffer = audioContext.createBuffer(numChannels, buffer.length, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const output = newBuffer.getChannelData(ch);

    for (let i = 0; i < buffer.length; i++) {
      output[i] = input[i];
    }

    // Fade-in coseno al inicio del sample
    for (let i = 0; i < fadeSamples; i++) {
      output[i] *= (1 - Math.cos(Math.PI * i / fadeSamples)) / 2;
    }

    // Fade-out coseno al final del sample
    for (let i = 0; i < fadeSamples; i++) {
      output[buffer.length - 1 - i] *= (1 - Math.cos(Math.PI * i / fadeSamples)) / 2;
    }
  }

  return newBuffer;
}

// Carga de audio para teclas blancas
function loadWhiteAudio(file) {
  initAudioContext();
  const reader = new FileReader();
  reader.onload = () => {
    audioContext.decodeAudioData(reader.result)
      .then(decodedBuffer => {
        whiteAudioBuffer = preprocessSample(decodedBuffer);
      })
      .catch(error => {
        console.error('Error al decodificar el audio blanco:', error);
      });
  };
  reader.onerror = () => {
    console.error('Error al leer el archivo de audio blanco.');
  };
  reader.readAsArrayBuffer(file);
}

// Carga de audio para teclas negras
function loadBlackAudio(file) {
  initAudioContext();
  const reader = new FileReader();
  reader.onload = () => {
    audioContext.decodeAudioData(reader.result)
      .then(decodedBuffer => {
        blackAudioBuffer = preprocessSample(decodedBuffer);
      })
      .catch(error => {
        console.error('Error al decodificar el audio negro:', error);
      });
  };
  reader.onerror = () => {
    console.error('Error al leer el archivo de audio negro.');
  };
  reader.readAsArrayBuffer(file);
}

function playSound(note, loop = false) {
  const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(Object.keys(keyToNote).find(k => keyToNote[k] === note));
  const audioBuffer = isBlackKey ? blackAudioBuffer : whiteAudioBuffer;

  if (!audioBuffer || activeSources[note]) {
    return;
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;

  const semitones = note - 60;
  const playbackRate = Math.pow(2, semitones / 12) * Math.pow(2, octave - 4);
  source.playbackRate.value = isFinite(playbackRate) ? playbackRate : 1;
  const detuneValue = baseFrequency > 0 ? 1200 * Math.log2(baseFrequency / 440) : 0;
  source.detune.value = isFinite(detuneValue) ? detuneValue : 0;

  const gainNode = audioContext.createGain();
  const targetVolume = isBlackKey ? blackVolume : whiteVolume;

  source.connect(gainNode);

  if (isChromaVerbActive && reverbNode) {
    const dryGain = audioContext.createGain();
    dryGain.gain.value = 0.7;
    gainNode.connect(dryGain);
    dryGain.connect(masterGain);
    gainNode.connect(reverbNode);
  } else {
    gainNode.connect(masterGain);
  }

  // Attack: setTargetAtTime con constante de 0.01s (95% en ~30ms, imperceptible)
  const now = audioContext.currentTime;
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.setTargetAtTime(targetVolume, now, 0.01);

  source.loop = loop;
  source.start(0);

  activeSources[note] = { source, gainNode, isBlackKey };

  source.onended = () => {
    if (!loop) {
      delete activeSources[note];
      const keyData = Object.values(keys).find(k => keyToNote[k.element.getAttribute('note')] === note);
      if (keyData && !keyData.isPressed) {
        keyData.element.classList.remove('pressed');
      }
    }
  };
}

function stopSound(note) {
  if (activeSources[note]) {
    const { source, gainNode } = activeSources[note];

    // Release: setTargetAtTime con constante de 0.015s (~95% decay en 45ms)
    const now = audioContext.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.setTargetAtTime(0, now, 0.015);

    // Detener source después de que el decay sea inaudible (5x time constant)
    setTimeout(() => {
      try {
        source.stop();
        source.disconnect();
        gainNode.disconnect();
      } catch (e) { /* ya detenido */ }
      delete activeSources[note];
    }, 100);
  }
}

function updateVolume(note) {
  if (activeSources[note]) {
    const { gainNode, isBlackKey } = activeSources[note];
    const newVolume = isBlackKey ? blackVolume : whiteVolume;
    gainNode.gain.cancelScheduledValues(audioContext.currentTime);
    gainNode.gain.setValueAtTime(newVolume, audioContext.currentTime);
  }
}

const keyToNote = {
  A: 60,
  W: 61,
  S: 62,
  E: 63,
  D: 64,
  F: 65,
  T: 66,
  G: 67,
  Y: 68,
  H: 69,
  U: 70,
  J: 71,
  K: 72,
  O: 73,
  L: 74,
  P: 75,
  semicolon: 76,
};

function createKeyboard() {
  const keyboard = document.getElementById('keyboard');
  const notes = Object.keys(keyToNote);

  notes.forEach((key) => {
    const keyElement = document.createElement('div');
    keyElement.classList.add('key', key === 'W' || key === 'E' || key === 'T' || key === 'Y' || key === 'U' || key === 'O' || key === 'P' ? 'black' : 'white');

    if (key === 'semicolon') {
      keyElement.textContent = '+';
      keyElement.classList.add('wolf-key');
    } else {
      keyElement.textContent = key;
    }

    keyElement.setAttribute('note', keyToNote[key]);

    const x = Math.random() * (window.innerWidth - 100);
    const y = Math.random() * (window.innerHeight - 100);
    keyElement.style.left = `${x}px`;
    keyElement.style.top = `${y}px`;

    keys[key] = { element: keyElement, x, y, dx: Math.random() - 0.5, dy: Math.random() - 0.5, isPressed: false, isManual: false };

    // Wolf key: abre popup de velocidad en lugar de tocar nota
    if (key === 'semicolon') {
      keyElement.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        toggleSpeedPopup(keyElement);
      });
      keyboard.appendChild(keyElement);
      return; // No agregar eventos de sonido
    }

    keyElement.addEventListener('mousedown', () => {
      const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
      const holdEnabled = isBlackKey ? blackHoldEnabled : whiteHoldEnabled;
      const heldNotes = isBlackKey ? blackHeldNotes : whiteHeldNotes;
      playSound(keyToNote[key], holdEnabled);
      keyElement.classList.add('pressed');
      if (holdEnabled) {
        heldNotes.add(keyToNote[key]);
      }
    });

    keyElement.addEventListener('mouseup', () => {
      const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
      const holdEnabled = isBlackKey ? blackHoldEnabled : whiteHoldEnabled;
      if (!holdEnabled) {
        stopSound(keyToNote[key]);
        keyElement.classList.remove('pressed');
      }
    });

    keyElement.addEventListener('mouseleave', () => {
      const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
      const holdEnabled = isBlackKey ? blackHoldEnabled : whiteHoldEnabled;
      if (!holdEnabled) {
        stopSound(keyToNote[key]);
        keyElement.classList.remove('pressed');
      }
    });

    keyboard.appendChild(keyElement);
  });

  animateKeys();
}

function animateKeys() {
  const keyboard = document.getElementById('keyboard');

  Object.keys(keys).forEach((key) => {
    const keyData = keys[key];

    // Wolf key se mueve independiente, las demás usan multiplicador
    let speedMult = 1;
    if (key !== 'semicolon') {
      const isBlack = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
      speedMult = isBlack ? blackKeySpeed : whiteKeySpeed;
    }

    keyData.x += keyData.dx * speedMult;
    keyData.y += keyData.dy * speedMult;

    if (keyData.x < 0 || keyData.x > window.innerWidth - (key === 'semicolon' ? 100 : 60)) {
      keyData.dx *= -1;
    }
    if (keyData.y < 0 || keyData.y > window.innerHeight - (key === 'semicolon' ? 100 : 60)) {
      keyData.dy *= -1;
    }

    keyData.element.style.left = `${keyData.x}px`;
    keyData.element.style.top = `${keyData.y}px`;
  });

  drawConnectionLines();
  requestAnimationFrame(animateKeys);
}

function drawConnectionLines() {
  const canvas = document.getElementById('connectionCanvas');
  const ctx = canvas.getContext('2d');

  // Ajustar tamaño del canvas al viewport
  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const semicolonKey = keys['semicolon'];
  if (!semicolonKey) return;

  const wolfRect = semicolonKey.element.getBoundingClientRect();
  const wolfCenterX = wolfRect.left + wolfRect.width / 2;
  const wolfCenterY = wolfRect.top + wolfRect.height / 2;

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 1;

  Object.keys(keys).forEach((key) => {
    if (key !== 'semicolon') {
      const keyData = keys[key];
      const keyRect = keyData.element.getBoundingClientRect();
      const keyCenterX = keyRect.left + keyRect.width / 2;
      const keyCenterY = keyRect.top + keyRect.height / 2;

      ctx.beginPath();
      ctx.moveTo(keyCenterX, keyCenterY);
      ctx.lineTo(wolfCenterX, wolfCenterY);
      ctx.stroke();
    }
  });
}

// === Limpieza de loops grabados ===
// Trimea residuos de inicio/final y aplica fades limpios (sin crossfade)
function applyLoopCrossfade(buffer) {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const threshold = 0.005; // Umbral para detectar audio real vs residuo

  // Usar canal 0 como referencia para detectar inicio/fin de audio
  const ref = buffer.getChannelData(0);

  // Encontrar primer sample con audio real (buscar en ventanas de 256 samples)
  const windowSize = 256;
  let trimStart = 0;
  for (let i = 0; i < ref.length - windowSize; i += windowSize) {
    let peak = 0;
    for (let j = i; j < i + windowSize; j++) {
      peak = Math.max(peak, Math.abs(ref[j]));
    }
    if (peak > threshold) {
      trimStart = Math.max(0, i - windowSize); // un bloque antes del audio
      break;
    }
  }

  // Encontrar último sample con audio real
  let trimEnd = ref.length;
  for (let i = ref.length - windowSize; i >= 0; i -= windowSize) {
    let peak = 0;
    for (let j = i; j < Math.min(i + windowSize, ref.length); j++) {
      peak = Math.max(peak, Math.abs(ref[j]));
    }
    if (peak > threshold) {
      trimEnd = Math.min(ref.length, i + windowSize * 2); // un bloque después
      break;
    }
  }

  // Asegurar longitud mínima
  const trimmedLength = trimEnd - trimStart;
  if (trimmedLength < sampleRate * 0.1) return buffer; // menos de 100ms, no procesar

  // Crear buffer trimado
  const newBuffer = audioContext.createBuffer(numChannels, trimmedLength, sampleRate);
  const fadeSamples = Math.min(Math.floor(sampleRate * 0.02), Math.floor(trimmedLength / 4)); // 20ms fade

  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const output = newBuffer.getChannelData(ch);

    // Copiar región trimada
    for (let i = 0; i < trimmedLength; i++) {
      output[i] = input[trimStart + i];
    }

    // Fade-in coseno
    for (let i = 0; i < fadeSamples; i++) {
      output[i] *= (1 - Math.cos(Math.PI * i / fadeSamples)) / 2;
    }

    // Fade-out coseno
    for (let i = 0; i < fadeSamples; i++) {
      output[trimmedLength - 1 - i] *= (1 - Math.cos(Math.PI * i / fadeSamples)) / 2;
    }
  }

  return newBuffer;
}

// Función para iniciar la grabación
function startRecording() {
  initAudioContext();
  const destination = audioContext.createMediaStreamDestination();

  // Gain node dedicado, SIN CONECTAR a masterGain todavía
  recordingGain = audioContext.createGain();
  recordingGain.gain.value = 0;
  recordingGain.connect(destination);
  // masterGain NO se conecta aún — silencio absoluto

  recorder = new MediaRecorder(destination.stream);
  recorder.ondataavailable = (e) => {
    recordedChunks.push(e.data);
  };
  recorder.onstop = () => {
    if (recordedChunks.length === 0) {
      console.error('No se grabaron datos de audio.');
      return;
    }
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    blobToArrayBuffer(blob).then(arrayBuffer => {
      audioContext.decodeAudioData(arrayBuffer)
        .then(buffer => {
          const channelData = buffer.getChannelData(0);
          const hasAudio = channelData.some(sample => Math.abs(sample) > 0.001);
          if (hasAudio) {
            const smoothedBuffer = applyLoopCrossfade(buffer);
            loops.push(smoothedBuffer);
            updateLoopList();
          } else {
            console.warn('El AudioBuffer está vacío o contiene solo silencio.');
          }
          recordedChunks = [];
        })
        .catch(error => console.error('Error al decodificar audio:', error));
    }).catch(error => console.error('Error al convertir Blob a ArrayBuffer:', error));
  };

  recorder.onerror = (e) => console.error('Error en MediaRecorder:', e);
  recorder.start(100);
  isRecording = true;
  document.getElementById('recordButton').classList.add('active');

  // Conectar masterGain y abrir gain DESPUÉS de 150ms de silencio puro
  setTimeout(() => {
    if (recordingGain) {
      masterGain.connect(recordingGain);
      const now = audioContext.currentTime;
      recordingGain.gain.setValueAtTime(0, now);
      recordingGain.gain.setTargetAtTime(1, now, 0.008);
    }
  }, 150);
}

// Convertir Blob a ArrayBuffer
function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Error al leer Blob'));
    reader.readAsArrayBuffer(blob);
  });
}

// Función para detener la grabación
function stopRecording() {
  if (recorder && isRecording) {
    isRecording = false;
    document.getElementById('recordButton').classList.remove('active');

    // Fade out solo la ruta de grabación (el audio en vivo sigue intacto)
    const now = audioContext.currentTime;
    recordingGain.gain.cancelScheduledValues(now);
    recordingGain.gain.setValueAtTime(recordingGain.gain.value, now);
    recordingGain.gain.setTargetAtTime(0, now, 0.01);

    // Detener el recorder después de que el fade termine (~80ms)
    setTimeout(() => {
      recorder.stop();
      if (recordingGain) {
        recordingGain.disconnect();
        recordingGain = null;
      }
    }, 80);
  }
}

// Actualizar la lista de loops en la ventana
function updateLoopList() {
  const loopList = document.getElementById('loopList');
  loopList.innerHTML = '';

  loops.forEach((loop, index) => {
    const listItem = document.createElement('li');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'loop-label-text';
    labelSpan.textContent = `Loop ${index + 1} (${loop.duration.toFixed(2)}s)`;
    labelSpan.addEventListener('click', () => {
      if (activeLoops[index]) {
        stopLoop(index);
      } else {
        playLoop(index);
      }
    });

    const exportBtn = document.createElement('button');
    exportBtn.className = 'loop-export-btn';
    exportBtn.textContent = '↓';
    exportBtn.title = 'Exportar .WAV';
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportLoopAsWav(index);
    });

    listItem.appendChild(labelSpan);
    listItem.appendChild(exportBtn);
    listItem.style.color = activeLoops[index] ? '#00cc00' : '#fff';
    loopList.appendChild(listItem);
  });
}

// === Exportar loop como archivo .WAV ===

function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Interleave channels and write PCM samples
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      sample = Math.max(-1, Math.min(1, sample));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function exportLoopAsWav(index) {
  const buffer = loops[index];
  if (!buffer) return;

  const wavBlob = audioBufferToWav(buffer);
  const url = URL.createObjectURL(wavBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `MAn-E_Loop_${index + 1}.wav`;
  a.click();
  URL.revokeObjectURL(url);
}

// Reproducir un loop
function playLoop(index) {
  const buffer = loops[index];
  if (!buffer) {
    console.error(`No hay buffer para Loop ${index + 1}`);
    return;
  }

  if (activeLoops[index]) {
    stopLoop(index);
    return;
  }

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const gainNode = audioContext.createGain();
  const now = audioContext.currentTime;
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.setTargetAtTime(loopVolume, now, 0.01);

  source.connect(gainNode);
  if (isChromaVerbActive && reverbNode) {
    const dryGain = audioContext.createGain();
    dryGain.gain.value = 0.7;
    gainNode.connect(dryGain);
    dryGain.connect(masterGain);
    gainNode.connect(reverbNode);
  } else {
    gainNode.connect(masterGain);
  }

  try {
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    source.start();
  } catch (error) {
    console.error(`Error al iniciar Loop ${index + 1}:`, error);
  }

  activeLoops[index] = { source, gainNode };

  const listItem = document.getElementById('loopList').children[index];
  listItem.style.color = '#00cc00';
}

// Detener un loop
function stopLoop(index) {
  if (activeLoops[index]) {
    const { source, gainNode } = activeLoops[index];
    const now = audioContext.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.setTargetAtTime(0, now, 0.015);

    setTimeout(() => {
      try {
        source.stop();
        source.disconnect();
        gainNode.disconnect();
      } catch (e) { /* ya detenido */ }
      delete activeLoops[index];
    }, 100);

    const listItem = document.getElementById('loopList').children[index];
    if (listItem) listItem.style.color = '#fff';
  }
}

// Borrar todos los loops
function clearLoops() {
  Object.keys(activeLoops).forEach(index => stopLoop(index));
  loops = [];
  updateLoopList();
}

// Eventos de teclado físico
document.addEventListener('keydown', (e) => {
  // Barra espaciadora: toggle grabación
  if (e.code === 'Space') {
    e.preventDefault();
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
    return;
  }

  const key = e.key.toUpperCase();
  if (keyToNote[key]) {
    const note = keyToNote[key];
    const keyData = keys[key];
    const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
    const holdEnabled = isBlackKey ? blackHoldEnabled : whiteHoldEnabled;
    const heldNotes = isBlackKey ? blackHeldNotes : whiteHeldNotes;
    if (keyData && !keyData.isPressed) {
      keyData.isPressed = true;
      keyData.isManual = true;
      playSound(note, holdEnabled);
      keyData.element.classList.add('pressed');
      if (holdEnabled) {
        heldNotes.add(note);
      }
    }
  }
});

document.addEventListener('keyup', (e) => {
  const key = e.key.toUpperCase();
  if (keyToNote[key]) {
    const note = keyToNote[key];
    const keyData = keys[key];
    const isBlackKey = ['W', 'E', 'T', 'Y', 'U', 'O', 'P'].includes(key);
    const holdEnabled = isBlackKey ? blackHoldEnabled : whiteHoldEnabled;
    if (keyData && keyData.isPressed) {
      keyData.isPressed = false;
      keyData.isManual = false;
      if (!holdEnabled) {
        stopSound(note);
        keyData.element.classList.remove('pressed');
      }
    }
  }
});

document.getElementById('whiteAudioFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    loadWhiteAudio(file);
  }
});

document.getElementById('blackAudioFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    loadBlackAudio(file);
  }
});

document.getElementById('baseFrequency').addEventListener('input', (e) => {
  baseFrequency = parseFloat(e.target.value) || 440;
});

document.getElementById('octave').addEventListener('input', (e) => {
  octave = parseInt(e.target.value) || 4;
});

document.getElementById('waveform').addEventListener('change', (e) => {
  waveform = e.target.value;
});

document.getElementById('whiteVolume').addEventListener('input', (e) => {
  whiteVolume = parseFloat(e.target.value);
  Object.keys(activeSources).forEach(note => {
    if (!activeSources[note].isBlackKey) {
      updateVolume(note);
    }
  });
});

document.getElementById('blackVolume').addEventListener('input', (e) => {
  blackVolume = parseFloat(e.target.value);
  Object.keys(activeSources).forEach(note => {
    if (activeSources[note].isBlackKey) {
      updateVolume(note);
    }
  });
});

document.getElementById('loopVolume').addEventListener('input', (e) => {
  loopVolume = parseFloat(e.target.value);
  Object.keys(activeLoops).forEach(index => {
    const { gainNode } = activeLoops[index];
    gainNode.gain.setValueAtTime(loopVolume, audioContext.currentTime);
  });
});

document.getElementById('whiteHoldToggle').addEventListener('change', (e) => {
  whiteHoldEnabled = e.target.checked;
  if (!whiteHoldEnabled) {
    whiteHeldNotes.forEach((note) => {
      stopSound(note);
      const keyData = Object.values(keys).find(k => keyToNote[k.element.getAttribute('note')] === note);
      if (keyData) {
        keyData.element.classList.remove('pressed');
      }
    });
    whiteHeldNotes.clear();
  }
});

document.getElementById('blackHoldToggle').addEventListener('change', (e) => {
  blackHoldEnabled = e.target.checked;
  if (!blackHoldEnabled) {
    blackHeldNotes.forEach((note) => {
      stopSound(note);
      const keyData = Object.values(keys).find(k => keyToNote[k.element.getAttribute('note')] === note);
      if (keyData) {
        keyData.element.classList.remove('pressed');
      }
    });
    blackHeldNotes.clear();
  }
});

document.getElementById('chromaVerbButton').addEventListener('click', () => {
  isChromaVerbActive = !isChromaVerbActive;

  if (isChromaVerbActive) {
    if (!reverbNode) {
      const { reverbNode: node, reverbGain } = createReverb();
      reverbNode = node;
    }
    Object.keys(activeSources).forEach(note => {
      const { gainNode } = activeSources[note];
      gainNode.disconnect();
      const dryGain = audioContext.createGain();
      dryGain.gain.value = 0.7;
      gainNode.connect(dryGain);
      dryGain.connect(masterGain);
      gainNode.connect(reverbNode);
    });
    document.getElementById('chromaVerbButton').classList.add('active');
  } else {
    Object.keys(activeSources).forEach(note => {
      const { gainNode } = activeSources[note];
      gainNode.disconnect();
      gainNode.connect(masterGain);
    });
    document.getElementById('chromaVerbButton').classList.remove('active');
  }
});

document.getElementById('recordButton').addEventListener('click', () => {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
});

document.getElementById('clearLoopsButton').addEventListener('click', () => {
  clearLoops();
});

// Referencias a los contenedores para colapsar
const leftControls = document.querySelector('.controls');
const rightPanel = document.querySelector('.right-panel');

// Función para alternar colapso
function toggleCollapse(container, button) {
  const isCollapsed = container.classList.contains('collapsed');
  if (isCollapsed) {
    container.classList.remove('collapsed');
    button.textContent = '−'; // Mostrar "−" cuando está expandido
  } else {
    container.classList.add('collapsed');
    button.textContent = '+'; // Mostrar "+" cuando está colapsado
  }
}

// Evento para colapsar controles izquierdos
collapseLeftButton.addEventListener('click', () => {
  toggleCollapse(leftControls, collapseLeftButton);
});

// Evento para colapsar panel derecho
collapseRightButton.addEventListener('click', () => {
  toggleCollapse(rightPanel, collapseRightButton);
});

// === Colapsar secciones individuales ===
document.querySelectorAll('.section-header').forEach(header => {
  header.addEventListener('click', () => {
    const content = header.nextElementSibling;
    const toggle = header.querySelector('.section-toggle');
    const isCollapsed = content.classList.toggle('section-collapsed');
    toggle.textContent = isCollapsed ? '+' : '−';
  });
});

// === Popup de velocidad del Wolf Key ===

const speedPopup = document.getElementById('speedPopup');
let speedPopupOpen = false;

function toggleSpeedPopup(wolfElement) {
  speedPopupOpen = !speedPopupOpen;
  if (speedPopupOpen) {
    const rect = wolfElement.getBoundingClientRect();
    speedPopup.style.left = `${rect.right + 10}px`;
    speedPopup.style.top = `${rect.top}px`;
    speedPopup.classList.remove('hidden');
  } else {
    speedPopup.classList.add('hidden');
  }
}

// Cerrar popup al hacer clic fuera
document.addEventListener('mousedown', (e) => {
  if (speedPopupOpen && !e.target.closest('#speedPopup') && !e.target.closest('.wolf-key')) {
    speedPopupOpen = false;
    speedPopup.classList.add('hidden');
  }
}, true);

// Evitar que el popup inicie dibujo
speedPopup.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

document.getElementById('whiteSpeedRange').addEventListener('input', (e) => {
  whiteKeySpeed = parseFloat(e.target.value);
  document.getElementById('whiteSpeedValue').textContent = whiteKeySpeed.toFixed(1);
});

document.getElementById('blackSpeedRange').addEventListener('input', (e) => {
  blackKeySpeed = parseFloat(e.target.value);
  document.getElementById('blackSpeedValue').textContent = blackKeySpeed.toFixed(1);
});

// Ocultar cursor personalizado sobre el popup
speedPopup.addEventListener('mouseenter', () => {
  customCursor.style.display = 'none';
});
speedPopup.addEventListener('mouseleave', () => {
  customCursor.style.display = 'block';
});

// === Sistema de Sesión (.mane) ===

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function saveSession() {
  initAudioContext();

  const session = {
    version: '1.0',
    type: 'mane-session',
    timestamp: new Date().toISOString(),
    settings: {
      baseFrequency,
      octave,
      waveform,
      whiteVolume,
      blackVolume,
      whiteHoldEnabled,
      blackHoldEnabled,
      whiteKeySpeed,
      blackKeySpeed,
      isChromaVerbActive,
      loopVolume
    },
    audio: {
      white: null,
      black: null
    },
    shapes: [],
    loops: []
  };

  if (whiteAudioBuffer) {
    const wavBlob = audioBufferToWav(whiteAudioBuffer);
    session.audio.white = await blobToBase64(wavBlob);
  }
  if (blackAudioBuffer) {
    const wavBlob = audioBufferToWav(blackAudioBuffer);
    session.audio.black = await blobToBase64(wavBlob);
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  lines.forEach(shape => {
    session.shapes.push({
      type: shape.type,
      closed: shape.closed,
      points: shape.points.map(([x, y]) => [x / vw, y / vh])
    });
  });

  for (const loop of loops) {
    const wavBlob = audioBufferToWav(loop);
    const b64 = await blobToBase64(wavBlob);
    session.loops.push(b64);
  }

  const json = JSON.stringify(session);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `MAn-E_Session_${Date.now()}.mane`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadSession(file) {
  initAudioContext();

  const text = await file.text();
  let session;
  try {
    session = JSON.parse(text);
  } catch (e) {
    console.error('Archivo .mane inválido');
    return;
  }

  if (session.type !== 'mane-session') {
    console.error('No es un archivo de sesión MAn/E');
    return;
  }

  const s = session.settings;

  baseFrequency = s.baseFrequency || 440;
  octave = s.octave || 4;
  waveform = s.waveform || 'sine';
  whiteVolume = s.whiteVolume !== undefined ? s.whiteVolume : 1;
  blackVolume = s.blackVolume !== undefined ? s.blackVolume : 1;
  whiteHoldEnabled = s.whiteHoldEnabled || false;
  blackHoldEnabled = s.blackHoldEnabled || false;
  whiteKeySpeed = s.whiteKeySpeed !== undefined ? s.whiteKeySpeed : 1;
  blackKeySpeed = s.blackKeySpeed !== undefined ? s.blackKeySpeed : 1;
  loopVolume = s.loopVolume !== undefined ? s.loopVolume : 1;

  document.getElementById('baseFrequency').value = baseFrequency;
  document.getElementById('octave').value = octave;
  document.getElementById('waveform').value = waveform;
  document.getElementById('whiteVolume').value = whiteVolume;
  document.getElementById('blackVolume').value = blackVolume;
  document.getElementById('whiteHoldToggle').checked = whiteHoldEnabled;
  document.getElementById('blackHoldToggle').checked = blackHoldEnabled;
  document.getElementById('loopVolume').value = loopVolume;
  document.getElementById('whiteSpeedRange').value = whiteKeySpeed;
  document.getElementById('whiteSpeedValue').textContent = whiteKeySpeed.toFixed(1);
  document.getElementById('blackSpeedRange').value = blackKeySpeed;
  document.getElementById('blackSpeedValue').textContent = blackKeySpeed.toFixed(1);

  if (s.isChromaVerbActive && !isChromaVerbActive) {
    document.getElementById('chromaVerbButton').click();
  } else if (!s.isChromaVerbActive && isChromaVerbActive) {
    document.getElementById('chromaVerbButton').click();
  }

  if (session.audio.white) {
    try {
      const arrayBuffer = base64ToArrayBuffer(session.audio.white);
      whiteAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      whiteAudioBuffer = preprocessSample(whiteAudioBuffer);
    } catch (e) {
      console.error('Error restaurando audio blanco:', e);
    }
  }
  if (session.audio.black) {
    try {
      const arrayBuffer = base64ToArrayBuffer(session.audio.black);
      blackAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      blackAudioBuffer = preprocessSample(blackAudioBuffer);
    } catch (e) {
      console.error('Error restaurando audio negro:', e);
    }
  }

  deleteAllLines();
  const drawingSvg = document.getElementById('drawingSvg');
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (session.shapes) {
    session.shapes.forEach(shape => {
      const denormPoints = shape.points.map(([x, y]) => [x * vw, y * vh]);

      let el;
      if (shape.type === 'line') {
        el = document.createElementNS(SVG_NS, 'line');
        el.setAttribute('x1', denormPoints[0][0]);
        el.setAttribute('y1', denormPoints[0][1]);
        el.setAttribute('x2', denormPoints[1][0]);
        el.setAttribute('y2', denormPoints[1][1]);
      } else if (shape.type === 'freehand') {
        el = document.createElementNS(SVG_NS, 'polyline');
        el.setAttribute('points', denormPoints.map(p => `${p[0]},${p[1]}`).join(' '));
        el.setAttribute('fill', 'none');
      } else if (shape.type === 'circle') {
        el = document.createElementNS(SVG_NS, 'ellipse');
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        denormPoints.forEach(([x, y]) => {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        });
        el.setAttribute('cx', (minX + maxX) / 2);
        el.setAttribute('cy', (minY + maxY) / 2);
        el.setAttribute('rx', (maxX - minX) / 2);
        el.setAttribute('ry', (maxY - minY) / 2);
      } else {
        el = document.createElementNS(SVG_NS, 'polygon');
        el.setAttribute('points', denormPoints.map(p => `${p[0]},${p[1]}`).join(' '));
      }

      el.classList.add('drawing-shape');
      drawingSvg.appendChild(el);

      const lineData = {
        element: el,
        type: shape.type,
        points: denormPoints,
        closed: shape.closed
      };
      lines.push(lineData);
    });
    updateLineList();
  }

  if (session.loops && session.loops.length > 0) {
    Object.keys(activeLoops).forEach(index => stopLoop(parseInt(index)));
    loops = [];

    for (const loopB64 of session.loops) {
      try {
        const arrayBuffer = base64ToArrayBuffer(loopB64);
        const buffer = await audioContext.decodeAudioData(arrayBuffer);
        loops.push(buffer);
      } catch (e) {
        console.error('Error restaurando loop:', e);
      }
    }
    updateLoopList();
  }
}

document.getElementById('saveSessionButton').addEventListener('click', () => {
  saveSession();
});

document.getElementById('loadSessionButton').addEventListener('click', () => {
  document.getElementById('sessionFileInput').click();
});

document.getElementById('sessionFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) {
    loadSession(file);
    e.target.value = '';
  }
});

createKeyboard();