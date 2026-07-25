const $ = (id) => document.getElementById(id);

const status = (msg, cls = '') => {
  $('status').textContent = msg;
  $('status').className = cls;
};

chrome.storage.sync.get({ server: '', token: '', autosync: true, autosyncMins: 240 }).then((cfg) => {
  $('server').value = cfg.server;
  $('token').value = cfg.token;
  $('autosync').checked = Boolean(cfg.autosync);
  $('autosyncMins').value = String(cfg.autosyncMins);
});

const readForm = () => ({
  server: $('server').value.trim().replace(/\/+$/, ''),
  token: $('token').value.trim(),
  autosync: $('autosync').checked,
  autosyncMins: Number($('autosyncMins').value) || 240,
});

$('save').addEventListener('click', async () => {
  const cfg = readForm();
  if (!/^https?:\/\//i.test(cfg.server)) {
    status('Enter the full server URL, including https://', 'err');
    return;
  }
  await chrome.storage.sync.set(cfg);
  status('Saved.', 'ok');
});

$('test').addEventListener('click', async () => {
  const cfg = readForm();
  if (!/^https?:\/\//i.test(cfg.server)) {
    status('Enter the full server URL, including https://', 'err');
    return;
  }
  status('Testing…');
  try {
    const res = await fetch(cfg.server + '/api/health', {
      headers: cfg.token ? { 'x-auth-token': cfg.token } : {},
    });
    const data = await res.json();
    if (!data.ok) throw new Error();
    if (data.authRequired && !data.authOk) {
      status('Server reached, but the token does not match its API_TOKEN secret.', 'err');
    } else {
      status('Connected.' + (data.authRequired ? ' Token accepted.' : ' No token required.'), 'ok');
    }
  } catch {
    status('Could not reach the server. Check the URL.', 'err');
  }
});
