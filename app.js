import { Fountain } from './lib/fountain.js';

// ============================================================
// DIAGNÓSTICO
// ============================================================
function showError(msg) {
  console.error('[Roteirista]', msg);
  let box = document.getElementById('__error_box');
  if (!box) {
    box = document.createElement('div');
    box.id = '__error_box';
    box.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;background:#c62828;color:#fff;' +
      'padding:8px 12px;font:12px/1.4 monospace;z-index:99999;' +
      'max-height:40vh;overflow:auto;white-space:pre-wrap;';
    document.body.appendChild(box);
  }
  box.textContent += (box.textContent ? '\n' : '') + msg;
}

window.addEventListener('error', (e) => {
  showError('Erro: ' + e.message + ' — ' + (e.filename || '') + ':' + (e.lineno || '?'));
});
window.addEventListener('unhandledrejection', (e) => {
  showError('Promise rejeitada: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});

function $(id) {
  const el = document.getElementById(id);
  if (!el) showError(`Elemento #${id} não encontrado. Atualize o index.html.`);
  return el;
}
function bind(id, event, handler) {
  const el = document.getElementById(id);
  if (!el) { showError(`Não foi possível ligar #${id}.`); return; }
  el.addEventListener(event, handler);
}

// ============================================================
// REFERÊNCIAS
// ============================================================
const editor = $('editor');
const preview = $('preview');
const previewContainer = $('preview-container');
const editorContainer = $('editor-container');
const productionContainer = $('production-container');
const btnToggle = $('btn-toggle');
const btnProduction = $('btn-production');
const statusEl = $('status');

const REQUIRED = { editor, preview, editorContainer, previewContainer, btnToggle, statusEl };
const missing = Object.entries(REQUIRED).filter(([, el]) => !el).map(([k]) => k);
if (missing.length > 0) {
  showError('HTML incompleto. Faltam: ' + missing.join(', '));
  throw new Error('HTML desatualizado');
}

let currentFileName = 'roteiro.fountain';
let currentView = 'editor';
const fountain = new Fountain();

// ============================================================
// Utilidades
// ============================================================
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function setStatus(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = 'Pronto'; }, 3000);
}

// ============================================================
// Remoção de notas DEC antes do parsing
// ============================================================
function stripNotes(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('[[') && t.endsWith(']]'));
    })
    .join('\n');
}

// ============================================================
// Utilidades Fountain
// ============================================================
function isSceneHeadingLine(line) {
  const t = (line || '').trim();
  if (!t) return false;
  if (/^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[\.\s]/i.test(t)) return true;
  if (t.startsWith('.') && !t.startsWith('..') && t.length > 1) return true;
  return false;
}
function parseSceneHeading(heading) {
  let trimmed = (heading || '').trim();
  if (trimmed.startsWith('.')) trimmed = trimmed.substring(1);
  const m = trimmed.match(/^(INT\.?\/EXT\.?|INT\/EXT|INT\.?|EXT\.?|EST\.?|I\/E)\s+(.+)$/i);
  let intExt = '', rest = trimmed;
  if (m) { intExt = m[1].replace(/\.$/, '').toUpperCase(); rest = m[2]; }
  const parts = rest.split(/\s+-\s+/);
  return {
    intExt,
    location: (parts[0] || '').trim().toUpperCase(),
    timeOfDay: (parts.slice(1).join(' - ') || '').trim().toUpperCase(),
  };
}

// ============================================================
// Personagens sem fala
// ============================================================
function extractCharactersWithoutDialogue(rawText) {
  const lines = rawText.split(/\r?\n/);
  const result = {};
  let currentSceneNum = 0;
  let inBoneyard = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (inBoneyard) {
      if (trimmed.includes('*/')) inBoneyard = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBoneyard = true;
      continue;
    }

    if (isSceneHeadingLine(lines[i])) {
      currentSceneNum++;
      continue;
    }

    if (
      trimmed.length >= 2 && trimmed.length <= 30 &&
      /^[A-Z][A-Z0-9\s'\-\.]*$/.test(trimmed) &&
      !/[\.:]$/.test(trimmed) &&
      !/^(INT|EXT|EST|I\/E)/.test(trimmed) &&
      !/^(FADE|CUT|DISSOLVE|SMASH)/.test(trimmed) &&
      i > 0 && lines[i - 1].trim() === '' &&
      (i + 1 >= lines.length || lines[i + 1].trim() === '')
    ) {
      if (!result[currentSceneNum]) result[currentSceneNum] = new Set();
      result[currentSceneNum].add(trimmed.replace(/\^$/, '').trim());
    }
  }

  const final = {};
  for (const [k, v] of Object.entries(result)) {
    final[Number(k)] = Array.from(v);
  }
  return final;
}

// ============================================================
// Renderização dos tokens (com diálogo duplo robusto)
// ============================================================
function renderTokens(tokens, rawText) {
  // 3ª fonte de detecção: "^" no texto bruto
  const dualChars = new Set();
  if (rawText) {
    for (const line of rawText.split(/\r?\n/)) {
      const t = line.trim();
      if (t.endsWith('^')) dualChars.add(t.slice(0, -1).trim().toUpperCase());
    }
  }

  const parts = [];
  let i = 0;
  let lastWasDialogue = false;
  let lastWasDualPair = false;

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'dialogue_begin') {
      let isDual = !!t.dual;
      const blockParts = ['<div class="dialogue-block">'];
      i++;
      if (i < tokens.length && tokens[i].type === 'character') {
        const rawName = String(tokens[i].text);
        const cleanName = rawName.replace(/\^$/, '').trim();
        // Fonte 1: flag do token
        if (tokens[i].dual) isDual = true;
        // Fonte 2: "^" no próprio texto do personagem
        if (rawName.trim().endsWith('^')) isDual = true;
        // Fonte 3: "^" no texto bruto
        if (dualChars.has(cleanName.toUpperCase())) isDual = true;
        blockParts.push(`<h4 class="character">${escapeHtml(cleanName)}</h4>`);
        i++;
      }
      while (i < tokens.length && tokens[i].type !== 'dialogue_end') {
        const dt = tokens[i];
        if (dt.type === 'parenthetical') blockParts.push(`<p class="parenthetical">${escapeHtml(dt.text)}</p>`);
        else if (dt.type === 'dialogue')  blockParts.push(`<p class="dialogue">${escapeHtml(dt.text)}</p>`);
        i++;
      }
      blockParts.push('</div>');
      i++;
      const blockHtml = blockParts.join('');

      if (isDual && lastWasDialogue && !lastWasDualPair && parts.length > 0) {
        const prev = parts.pop();
        parts.push(
          `<div class="dual-dialogue">` +
            `<div class="dual-col">${prev}</div>` +
            `<div class="dual-col">${blockHtml}</div>` +
          `</div>`
        );
        lastWasDialogue = false;
        lastWasDualPair = true;
      } else {
        parts.push(blockHtml);
        lastWasDialogue = true;
        lastWasDualPair = false;
      }
      continue;
    }

    switch (t.type) {
      case 'scene_heading': parts.push(`<h3 class="scene-heading">${escapeHtml(t.text)}</h3>`); break;
      case 'action':        parts.push(`<p class="action">${escapeHtml(t.text)}</p>`); break;
      case 'transition':    parts.push(`<h2 class="transition">${escapeHtml(t.text)}</h2>`); break;
      case 'centered':      parts.push(`<p class="centered">${escapeHtml(t.text)}</p>`); break;
      case 'lyrics':        parts.push(`<p class="lyrics">${escapeHtml(t.text)}</p>`); break;
      case 'page_break':    parts.push('<div class="page-break"></div>'); break;
    }
    // Qualquer token que não seja diálogo zera os flags
    if (t.type !== 'dialogue_begin' && t.type !== 'character' &&
        t.type !== 'dialogue' && t.type !== 'dialogue_end' &&
        t.type !== 'parenthetical') {
      lastWasDialogue = false;
      lastWasDualPair = false;
    }
    i++;
  }
  return parts.join('\n');
}

// ============================================================
// Preview: título em "página" separada + script em outra
// ============================================================
function updatePreview() {
  try {
    const cleanText = stripNotes(editor.value);
    const output = fountain.parse(cleanText, true);

    let html = '';

    if (output.html && output.html.title_page) {
      html += `<section class="screenplay-page" data-page="title">${output.html.title_page}</section>`;
    }

    const scriptHtml = output.tokens
      ? renderTokens(output.tokens, editor.value)
      : (output.html && output.html.script) || '';
    html += `<section class="screenplay-page" data-page="script">${scriptHtml}</section>`;

    preview.innerHTML = html;
  } catch (err) {
    console.error(err);
    preview.innerHTML = '<p style="color:#c00;padding:1em;">Erro ao processar o roteiro.</p>';
  }
}

// ============================================================
// Extração de dados de produção
// ============================================================
function extractProductionData(rawText) {
  const cleanText = stripNotes(rawText);
  const output = fountain.parse(cleanText, true);
  const tokens = output.tokens || [];
  const scenes = [];
  let currentScene = null, currentCharacter = null, dialogueContent = [];

  const flush = () => {
    if (!currentScene || !currentCharacter) { currentCharacter = null; dialogueContent = []; return; }
    if (dialogueContent.length > 0) {
      currentScene.dialogues.push({ character: currentCharacter, content: dialogueContent.slice() });
      const u = currentCharacter.toUpperCase();
      if (!currentScene.characters.includes(u)) currentScene.characters.push(u);
    }
    currentCharacter = null; dialogueContent = [];
  };

  for (const t of tokens) {
    if (t.type === 'scene_heading') {
      flush();
      const p = parseSceneHeading(t.text);
      currentScene = {
        number: scenes.length + 1, heading: t.text,
        intExt: p.intExt, location: p.location, timeOfDay: p.timeOfDay,
        characters: [], dialogueCount: 0, dialogues: [], decupagem: [],
      };
      scenes.push(currentScene);
    } else if (t.type === 'character' && currentScene) {
      flush();
      currentCharacter = String(t.text).trim().replace(/\^$/, '').trim();
    } else if (t.type === 'parenthetical' && currentScene && currentCharacter) {
      dialogueContent.push({ type: 'parenthetical', text: t.text });
    } else if (t.type === 'dialogue' && currentScene && currentCharacter) {
      dialogueContent.push({ type: 'dialogue', text: t.text });
      currentScene.dialogueCount++;
    }
  }
  flush();

  // Adiciona personagens sem fala
  const semFala = extractCharactersWithoutDialogue(rawText);
  for (const scene of scenes) {
    const extras = semFala[scene.number] || [];
    for (const name of extras) {
      const upper = name.toUpperCase();
      if (!scene.characters.includes(upper)) scene.characters.push(upper);
    }
  }

  // Lê DEC das linhas brutas
  const lines = rawText.split(/\r?\n/);
  let sceneIdx = 0, inBoneyard = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBoneyard) { if (t.includes('*/')) inBoneyard = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBoneyard = true; continue; }
    if (isSceneHeadingLine(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim();
        if (next === '') continue;
        const match = next.match(/^\[\[DEC:\s*(.*?)\]\]$/i);
        if (match && scenes[sceneIdx]) {
          scenes[sceneIdx].decupagem = match[1].split(';').map(s => s.trim()).filter(Boolean);
        }
        break;
      }
      sceneIdx++;
    }
  }

  const locations = {};
  for (const scene of scenes) {
    const key = (scene.intExt ? scene.intExt + '. ' : '') + (scene.location || 'SEM LOCAÇÃO');
    if (!locations[key]) locations[key] = { intExt: scene.intExt, location: scene.location, byTime: {} };
    const tk = scene.timeOfDay || '(sem indicação)';
    (locations[key].byTime[tk] = locations[key].byTime[tk] || []).push(scene);
  }
  const characters = {};
  for (const scene of scenes) {
    for (const d of scene.dialogues) {
      const name = d.character.toUpperCase();
      (characters[name] = characters[name] || []).push({
        sceneNumber: scene.number, sceneHeading: scene.heading, content: d.content,
      });
    }
  }
  return { scenes, locations, characters };
}

// ============================================================
// Views
// ============================================================
function renderLocationsView(data) {
  const el = $('tab-locations'); if (!el) return;
  const entries = Object.entries(data.locations);
  if (!entries.length) { el.innerHTML = '<p class="empty-state">Nenhuma cena encontrada.</p>'; return; }
  let html = '';
  for (const [key, loc] of entries) {
    html += `<div class="location-group"><h3>${escapeHtml(key)}</h3>`;
    for (const [time, scenes] of Object.entries(loc.byTime)) {
      html += `<div class="time-group"><h4>${escapeHtml(time)}</h4><ul>`;
      for (const s of scenes) {
        const c = s.characters.length, d = s.dialogueCount;
        html += `<li><span class="scene-num">Cena ${s.number}</span> — ${c} ${c === 1 ? 'personagem' : 'personagens'} — ${d} ${d === 1 ? 'diálogo' : 'diálogos'}</li>`;
      }
      html += '</ul></div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderCharactersView(data) {
  const el = $('tab-characters'); if (!el) return;
  const names = Object.keys(data.characters).sort();
  if (!names.length) { el.innerHTML = '<p class="empty-state">Nenhum personagem com diálogo.</p>'; return; }
  let html = '';
  for (const name of names) {
    html += `<div class="character-group"><h3>${escapeHtml(name)}</h3>`;
    for (const d of data.characters[name]) {
      html += `<div class="scene-dialogues"><div class="scene-label">Cena ${d.sceneNumber}:</div><ul>`;
      for (const item of d.content) {
        if (item.type === 'parenthetical') html += `<li><em>${escapeHtml(item.text)}</em></li>`;
        else html += `<li>“${escapeHtml(item.text)}”</li>`;
      }
      html += `</ul></div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

function renderDecupagemView(data) {
  const el = $('tab-decupagem'); if (!el) return;
  if (!data.scenes.length) { el.innerHTML = '<p class="empty-state">Nenhuma cena encontrada.</p>'; return; }
  let html = '';
  for (const s of data.scenes) {
    html += `<div class="decupagem-scene" data-scene-number="${s.number}">`;
    html += `<h3><span class="scene-num">Cena ${s.number}</span> — ${escapeHtml(s.heading)}</h3>`;
    html += `<div class="decupagem-items">`;
    if (!s.decupagem.length) html += `<span class="empty-hint">(nenhum item marcado)</span>`;
    else for (const item of s.decupagem)
      html += `<span class="decupagem-tag">${escapeHtml(item)} <button class="remove-item" data-scene="${s.number}" data-item="${escapeHtml(item)}">×</button></span>`;
    html += `</div><div class="decupagem-add">`;
    html += `<input type="text" placeholder="Adicionar item..." data-scene="${s.number}" class="decupagem-input">`;
    html += `<button class="add-item" data-scene="${s.number}">+ Adicionar</button>`;
    html += `</div></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.add-item').forEach(btn => btn.addEventListener('click', () => {
    const n = parseInt(btn.dataset.scene, 10);
    const v = btn.previousElementSibling.value.trim();
    if (v) addDecupagemItem(n, v);
  }));
  el.querySelectorAll('.decupagem-input').forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const n = parseInt(inp.dataset.scene, 10); const v = inp.value.trim(); if (v) addDecupagemItem(n, v); }
  }));
  el.querySelectorAll('.remove-item').forEach(btn => btn.addEventListener('click', () => {
    removeDecupagemItem(parseInt(btn.dataset.scene, 10), btn.dataset.item);
  }));
}

// ============================================================
// Decupagem: escreve no .fountain
// ============================================================
function updateSceneDecupagem(sceneNumber, newItems) {
  const lines = editor.value.split(/\r?\n/);
  let sceneCount = 0, headingIndex = -1, inBoneyard = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBoneyard) { if (t.includes('*/')) inBoneyard = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBoneyard = true; continue; }
    if (isSceneHeadingLine(lines[i])) { sceneCount++; if (sceneCount === sceneNumber) { headingIndex = i; break; } }
  }
  if (headingIndex === -1) return;
  let noteIndex = -1;
  for (let j = headingIndex + 1; j < Math.min(headingIndex + 4, lines.length); j++) {
    const t = lines[j].trim();
    if (t === '') continue;
    if (/^\[\[DEC:\s*.*?\]\]$/i.test(t)) noteIndex = j;
    break;
  }
  const newNote = newItems.length > 0 ? `[[DEC: ${newItems.join('; ')}]]` : null;
  if (noteIndex >= 0) { if (newNote) lines[noteIndex] = newNote; else lines.splice(noteIndex, 1); }
  else if (newNote) lines.splice(headingIndex + 1, 0, newNote);
  const cursor = Math.min(editor.selectionStart, lines.join('\n').length);
  editor.value = lines.join('\n');
  editor.selectionStart = editor.selectionEnd = cursor;
}
function addDecupagemItem(n, item) {
  const d = extractProductionData(editor.value);
  const s = d.scenes.find(x => x.number === n); if (!s) return;
  const items = s.decupagem.slice(); if (!items.includes(item)) items.push(item);
  updateSceneDecupagem(n, items); refreshProductionView();
}
function removeDecupagemItem(n, item) {
  const d = extractProductionData(editor.value);
  const s = d.scenes.find(x => x.number === n); if (!s) return;
  updateSceneDecupagem(n, s.decupagem.filter(i => i !== item)); refreshProductionView();
}

// ============================================================
// Views
// ============================================================
function setView(view) {
  currentView = view;
  if (editorContainer) editorContainer.classList.toggle('hidden', view !== 'editor');
  if (previewContainer) previewContainer.classList.toggle('active', view === 'preview');
  if (productionContainer) productionContainer.classList.toggle('active', view === 'production');
  if (btnToggle) btnToggle.textContent = view === 'editor' ? 'Visualizar' : 'Editar';
  if (view === 'preview') updatePreview();
  if (view === 'production') refreshProductionView();
}
function refreshProductionView() {
  if (currentView !== 'production') return;
  try {
    const data = extractProductionData(editor.value);
    renderLocationsView(data);
    renderCharactersView(data);
    renderDecupagemView(data);
  } catch (err) { showError('Erro na produção: ' + err.message); }
}

// ============================================================
// Handlers
// ============================================================
bind('btn-toggle', 'click', () => setView(currentView === 'editor' ? 'preview' : 'editor'));
bind('btn-production', 'click', () => setView(currentView === 'production' ? 'editor' : 'production'));
bind('btn-new', 'click', () => {
  if (confirm('Descartar o roteiro atual e começar um novo?')) {
    editor.value = ''; currentFileName = 'roteiro.fountain'; setView('editor'); setStatus('Novo roteiro criado');
  }
});
bind('btn-open', 'click', () => {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.fountain,.txt';
  input.onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { editor.value = ev.target.result; currentFileName = file.name; setView('editor'); setStatus('Aberto: ' + file.name); };
    reader.readAsText(file);
  };
  input.click();
});
bind('btn-save', 'click', () => {
  const blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentFileName.endsWith('.fountain') ? currentFileName : currentFileName + '.fountain';
  a.click(); URL.revokeObjectURL(url);
  setStatus('Salvo: ' + a.download);
});
bind('btn-pdf', 'click', () => {
  updatePreview(); setView('preview');
  setTimeout(() => window.print(), 200);
});
bind('btn-prod-export', 'click', () => {
  const activeTab = (document.querySelector('.tabs button.active') || {}).dataset?.tab || 'locations';
  const data = extractProductionData(editor.value);
  let text = '';
  if (activeTab === 'locations') {
    text = 'LOCAÇÕES\n\n';
    for (const [key, loc] of Object.entries(data.locations)) {
      text += `- ${key}\n`;
      for (const [time, scenes] of Object.entries(loc.byTime)) {
        text += `  ${time}:\n`;
        for (const s of scenes) text += `    - Cena ${s.number} - ${s.characters.length} personagens - ${s.dialogueCount} diálogos\n`;
      }
      text += '\n';
    }
  } else if (activeTab === 'characters') {
    text = 'DIÁLOGOS POR PERSONAGEM\n\n';
    for (const name of Object.keys(data.characters).sort()) {
      text += `${name}\n`;
      for (const d of data.characters[name]) {
        text += `  Cena ${d.sceneNumber}:\n`;
        for (const item of d.content) {
          if (item.type === 'dialogue') text += `    - "${item.text}"\n`;
          else text += `    ${item.text}\n`;
        }
      }
      text += '\n';
    }
  } else {
    text = 'DECUPAGEM\n\n';
    for (const s of data.scenes) {
      if (!s.decupagem.length) continue;
      text += `Cena ${s.number} (${s.heading})\n`;
      for (const item of s.decupagem) text += `  - ${item}\n`;
      text += '\n';
    }
  }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `producao-${activeTab}.txt`; a.click(); URL.revokeObjectURL(url);
  setStatus('Exportado: producao-' + activeTab + '.txt');
});

// Abas
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.getElementById('tab-' + btn.dataset.tab);
    if (panel) panel.classList.add('active');
  });
});

// ============================================================
// Init
// ============================================================
window.addEventListener('load', () => {
  if (!editor.value) {
    editor.value = `Title: ROTEIRO DE TESTE
Credit: Créditos
Author: Autor
Source: baseado em vozes da minha cabeça
Draft date: 23/10/2026
Contact: teste@fountain.com

FADE IN:

INT. LOCAÇÃO 1 - DIA

JOÃO
Fala alguma coisa

MARIA ^
Responde qualquer coisa

EXT. LOCAÇÃO 2 - NOITE

MARIA
Blá, blá, blá...

INT. LOCAÇÃO 1 - NOITE

[[DEC: Fone de ouvido]]

JOÃO
(entrando)
Nunca nem vi.

INT. LOCAÇÃO 1 - DIA

MARIA caminha sozinha ouvindo música

> THE END <`;
  }
  setView('editor');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated') {
            console.log('[Roteirista] Nova versão ativa. Recarregue.');
            showError('Nova versão disponível — recarregue a página.');
          }
        });
      });
    }).catch((err) => showError('Falha ao registrar SW: ' + err.message));
  }
});