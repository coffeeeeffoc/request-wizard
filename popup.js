document.addEventListener('DOMContentLoaded', async () => {
  const globalToggle = document.getElementById('globalToggle');
  const groupList = document.getElementById('groupList');
  const btnSettings = document.getElementById('btnSettings');
  const btnOptions = document.getElementById('btnOptions');

  let data = await new Promise(r => chrome.runtime.sendMessage({ type: 'RW_GET_DATA' }, r));

  function render() {
    globalToggle.checked = data.globalEnabled;
    groupList.innerHTML = '';

    if (!data.ruleGroups || data.ruleGroups.length === 0) {
      groupList.innerHTML = `<div class="empty">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg>
        <div>No rule groups yet.<br>Click "Edit Rules" to create one.</div>
      </div>`;
      return;
    }

    for (const group of data.ruleGroups) {
      const activeCount = group.rules.filter(r => r.enabled).length;
      const totalCount = group.rules.length;
      const el = document.createElement('div');
      el.className = 'group';
      el.innerHTML = `
        <div class="group-head">
          <div class="group-info">
            <span class="group-name">${escapeHtml(group.name)}</span>
            <span class="group-badge ${group.enabled ? '' : 'off'}">${activeCount}/${totalCount}</span>
          </div>
          <label class="mini-toggle" onclick="event.stopPropagation()">
            <input type="checkbox" ${group.enabled ? 'checked' : ''} data-gid="${group.id}">
            <span class="slider"></span>
          </label>
        </div>
      `;
      groupList.appendChild(el);

      el.querySelector('input[data-gid]').addEventListener('change', async (e) => {
        group.enabled = e.target.checked;
        await chrome.runtime.sendMessage({ type: 'RW_SAVE_DATA', payload: data });
        render();
      });
    }
  }

  globalToggle.addEventListener('change', async () => {
    data.globalEnabled = globalToggle.checked;
    await chrome.runtime.sendMessage({ type: 'RW_SAVE_DATA', payload: data });
  });

  btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  render();
});
