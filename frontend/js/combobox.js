/* ==============================================================
   COMBOBOX — reusable searchable dropdown selector
   Generic factory function for selecting items by code/name.
   ============================================================== */

let comboboxUid = 0;

/**
 * Create a combobox instance attached to a container element.
 *
 * @param {Object} options
 * @param {HTMLElement} options.container - Element to render into
 * @param {string}   options.name - Form field name for the hidden input
 * @param {string}   options.placeholder - Placeholder text
 * @param {Array}    options.items - Array of { code, name, type, level }
 * @param {string}   [options.value] - Initial selected code
 * @returns {{ getValue: () => string, setValue: (code: string) => void, setItems: (items: Array) => void, destroy: () => void }}
 */
function createCombobox({ container, name, placeholder = 'Search...', items = [], value = '' }) {
  const uid = ++comboboxUid;
  const listId = `combobox-list-${uid}`;
  const MAX_VISIBLE = 50;

  let allItems = items;
  let filtered = [];
  let selectedCode = '';
  let highlightIndex = -1;
  let isOpen = false;
  let outsideHandler = null;

  // --- DOM ---
  const root = document.createElement('div');
  root.className = 'combobox';

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.name = name;
  hidden.value = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combobox-input sandbox-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', listId);

  const dropdown = document.createElement('div');
  dropdown.className = 'combobox-dropdown';
  dropdown.id = listId;
  dropdown.setAttribute('role', 'listbox');
  dropdown.hidden = true;

  root.appendChild(hidden);
  root.appendChild(input);
  root.appendChild(dropdown);
  container.appendChild(root);

  // --- Helpers ---

  function displayText(item) {
    if (!item) return '';
    return `${item.code} (${item.name})`;
  }

  function filterItems(needle) {
    if (!needle) return allItems.slice(0, MAX_VISIBLE);
    const lower = needle.toLowerCase();
    const matches = [];
    for (const item of allItems) {
      if (item.code.includes(lower) || item.name.toLowerCase().includes(lower)) {
        matches.push(item);
        if (matches.length >= MAX_VISIBLE) break;
      }
    }
    return matches;
  }

  function renderRows() {
    if (filtered.length === 0) {
      dropdown.innerHTML = '<div class="combobox-empty">No matches</div>';
      return;
    }
    const html = [];
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      const hl = i === highlightIndex ? ' is-highlighted' : '';
      const sel = item.code === selectedCode ? ' is-selected' : '';
      const meta = `LV${item.level} ${item.type}`;
      html.push(
        `<div class="combobox-row${hl}${sel}" role="option" data-index="${i}" data-code="${escapeHtml(item.code)}" id="${listId}-opt-${i}">`
        + `<span class="combobox-row-code">${escapeHtml(item.code)}</span>`
        + `<span class="combobox-row-name">${escapeHtml(item.name)}</span>`
        + `<span class="combobox-row-meta">${escapeHtml(meta)}</span>`
        + `</div>`
      );
    }
    dropdown.innerHTML = html.join('');
  }

  function positionDropdown() {
    const rect = input.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom}px`;
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = `${rect.width}px`;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    positionDropdown();
    addOutsideHandler();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    dropdown.hidden = true;
    highlightIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    removeOutsideHandler();
  }

  function selectItem(item) {
    selectedCode = item ? item.code : '';
    hidden.value = selectedCode;
    input.value = item ? displayText(item) : '';
    close();
  }

  function findItemByCode(code) {
    if (!code) return null;
    return allItems.find(i => i.code === code) || null;
  }

  function scrollHighlightIntoView() {
    if (highlightIndex < 0) return;
    const row = dropdown.querySelector(`[data-index="${highlightIndex}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function updateHighlight(newIndex) {
    highlightIndex = newIndex;
    renderRows();
    scrollHighlightIntoView();
    if (highlightIndex >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-opt-${highlightIndex}`);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  // --- Event handlers ---

  function onInput() {
    const needle = input.value.trim();
    filtered = filterItems(needle);
    highlightIndex = -1;
    renderRows();
    if (!isOpen) open();
    positionDropdown();
  }

  function onKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        filtered = filterItems(input.value.trim());
        renderRows();
        open();
      }
      const next = highlightIndex < filtered.length - 1 ? highlightIndex + 1 : 0;
      updateHighlight(next);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) return;
      const prev = highlightIndex > 0 ? highlightIndex - 1 : filtered.length - 1;
      updateHighlight(prev);
    } else if (e.key === 'Enter') {
      if (isOpen && highlightIndex >= 0 && highlightIndex < filtered.length) {
        e.preventDefault();
        selectItem(filtered[highlightIndex]);
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault();
        // Restore display text
        const item = findItemByCode(selectedCode);
        input.value = item ? displayText(item) : '';
        close();
      }
    }
  }

  function onFocus() {
    if (allItems.length > 0) {
      filtered = filterItems(input.value.trim());
      renderRows();
      open();
    }
  }

  function onDropdownClick(e) {
    const row = e.target.closest('.combobox-row');
    if (!row) return;
    const code = row.dataset.code;
    const item = findItemByCode(code);
    if (item) selectItem(item);
  }

  function onDropdownMousedown(e) {
    // Prevent blur on the input when clicking the dropdown
    e.preventDefault();
  }

  function addOutsideHandler() {
    if (outsideHandler) return;
    outsideHandler = (e) => {
      if (!root.contains(e.target)) close();
    };
    document.addEventListener('mousedown', outsideHandler, true);
  }

  function removeOutsideHandler() {
    if (!outsideHandler) return;
    document.removeEventListener('mousedown', outsideHandler, true);
    outsideHandler = null;
  }

  // --- Bind events ---
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeydown);
  input.addEventListener('focus', onFocus);
  dropdown.addEventListener('click', onDropdownClick);
  dropdown.addEventListener('mousedown', onDropdownMousedown);

  // --- Set initial value ---
  if (value) {
    const initial = findItemByCode(value);
    if (initial) selectItem(initial);
  }

  // --- Public API ---
  return {
    getValue() {
      return hidden.value;
    },
    setValue(code) {
      const item = findItemByCode(code);
      selectItem(item);
    },
    setItems(newItems) {
      allItems = newItems || [];
      // Re-filter if dropdown is open
      if (isOpen) {
        filtered = filterItems(input.value.trim());
        renderRows();
      }
    },
    destroy() {
      close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeydown);
      input.removeEventListener('focus', onFocus);
      dropdown.removeEventListener('click', onDropdownClick);
      dropdown.removeEventListener('mousedown', onDropdownMousedown);
      root.remove();
    },
  };
}
