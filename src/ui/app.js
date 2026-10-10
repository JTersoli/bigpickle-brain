// The page for bigpickle-brain: start a run, watch its log, read what it wrote, and see every run's time and cost.
// Plain browser JavaScript, no build step, same origin as the API.

const TOKEN_KEY = 'bigpickle-brain-token';

const $ = (selector) => document.querySelector(selector);

function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key === 'class') {
			node.className = value;
		} else if (key === 'hidden') {
			node.hidden = Boolean(value);
		} else if (key.startsWith('on')) {
			node.addEventListener(key.slice(2), value);
		} else {
			node.setAttribute(key, value);
		}
	}
	for (const child of [].concat(children)) {
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

function token() {
	try {
		return localStorage.getItem(TOKEN_KEY) || '';
	} catch {
		return '';
	}
}

function askToken() {
	const given = window.prompt('This server needs its token (BRAIN_SERVER_TOKEN):');
	if (given === null) {
		return false;
	}
	try {
		localStorage.setItem(TOKEN_KEY, given.trim());
	} catch {
		// Private windows may refuse; the token then lasts one request.
	}
	return true;
}

async function api(route, options = {}) {
	const headers = { ...(options.headers || {}) };
	if (token()) {
		headers.Authorization = `Bearer ${token()}`;
	}
	const response = await fetch(route, { ...options, headers });
	if (response.status === 401) {
		if (askToken()) {
			return api(route, options);
		}
		throw new Error('A token is required.');
	}
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(body.error || `${response.status} ${response.statusText}`);
	}
	return body;
}

function duration(ms) {
	if (ms === null || ms === undefined) {
		return '-';
	}
	if (ms < 60000) {
		return `${Math.round(ms / 1000)} s`;
	}
	if (ms < 3600000) {
		return `${(ms / 60000).toFixed(1)} min`;
	}
	return `${(ms / 3600000).toFixed(1)} h`;
}

function cost(value) {
	if (value === null || value === undefined) {
		return 'n/a';
	}
	return `~$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function money(value, currency) {
	return `${currency || 'AUD'} ${Math.round(value).toLocaleString('en-US')}`;
}

function startedAt(iso) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return iso;
	}
	const pad = (n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function pill(text) {
	return el('span', { class: `pill ${text}` }, text);
}

// --- Status ------------------------------------------------------------------

async function loadStatus() {
	try {
		const status = await api('/api/status');
		$('#provider').textContent = `${status.provider} · effort ${status.effort} · ${status.maxRevisions} rewrite${status.maxRevisions === 1 ? '' : 's'}`;
		$('[name=revisions]').placeholder = String(status.maxRevisions);
		if (status.queue.running) {
			watchJob(status.queue.running);
		}
	} catch (error) {
		$('#provider').textContent = error.message;
	}
}

// --- Runs and metrics --------------------------------------------------------

async function loadRuns() {
	const { runs, summary } = await api('/api/runs?limit=100');
	const tiles = $('#tiles');
	tiles.replaceChildren();
	const pipeline = summary.kinds.find((kind) => kind.kind === 'pipeline');
	const tile = (value, label) => el('div', { class: 'tile' }, [el('div', { class: 'value' }, value), el('div', { class: 'label' }, label)]);
	tiles.append(
		tile(String(summary.runs), `run${summary.runs === 1 ? '' : 's'}${summary.failed ? `, ${summary.failed} failed` : ''}`),
		tile(pipeline ? String(pipeline.runs) : '0', 'pipelines'),
		tile(pipeline && pipeline.averageDurationMs !== null ? duration(pipeline.averageDurationMs) : '-', 'avg pipeline time'),
		tile(pipeline && pipeline.averageCost !== null ? cost(pipeline.averageCost) : '-', 'avg pipeline cost'),
		tile(cost(summary.totalCost), `total cost${summary.unpriced ? ` (${summary.unpriced} unpriced)` : ''}`),
		tile(`${Math.round((summary.usage.inputTokens + summary.usage.cacheReadTokens) / 1000)}k / ${Math.round(summary.usage.outputTokens / 1000)}k`, 'tokens in / out'),
	);

	const body = $('#runs-table tbody');
	body.replaceChildren();
	$('#runs-empty').hidden = runs.length > 0;
	for (const run of runs) {
		const row = el('tr', { onclick: () => openRun(run.name) }, [
			el('td', {}, startedAt(run.startedAt)),
			el('td', {}, run.kind),
			el('td', {}, run.client || '-'),
			el('td', {}, run.model || '-'),
			el('td', { class: 'num' }, run.steps === null ? '-' : String(run.steps)),
			el('td', { class: 'num' }, duration(run.durationMs)),
			el('td', { class: 'num' }, cost(run.cost)),
			el('td', {}, run.outcome ? (['approve', 'revise', 'reject'].includes(run.outcome) ? pill(run.outcome) : run.outcome) : '-'),
		]);
		body.append(row);
	}
}

async function openRun(name) {
	try {
		const { dir, summary } = await api(`/api/runs/${encodeURIComponent(name)}`);
		const kind = summary.kind || kindFromName(name);
		const lines = [];
		const add = (key, value) => value !== undefined && value !== null && lines.push(`${key}: ${value}`);
		add('run', name);
		add('kind', kind);
		add('client', summary.client || summary.clientName);
		add('model', summary.model);
		add('started', summary.startedAt && startedAt(summary.startedAt));
		add('duration', summary.durationMs !== undefined ? duration(summary.durationMs) : undefined);
		add('steps', summary.steps);
		add('verdict', summary.verdict);
		add('cost', summary.cost !== undefined ? cost(summary.cost) : undefined);
		if (summary.usage) {
			add('tokens', `${summary.usage.inputTokens.toLocaleString('en-US')} in, ${summary.usage.outputTokens.toLocaleString('en-US')} out, ${summary.usage.cacheReadTokens.toLocaleString('en-US')} from cache, ${summary.usage.requests} requests`);
		}
		add('failure', summary.failure && `${summary.failure}: ${summary.error || ''}`);
		if (summary.brief) {
			lines.push('', 'brief:', summary.brief);
		}
		const notes = [];
		const note = (label, path) => path && notes.push(el('button', { class: 'link', onclick: () => openNote(label, path) }, label));
		// A stage run's reportPath is the note it wrote: the research report, the proposal, the review or the eval report.
		const own = { research: 'report', proposal: 'proposal', review: 'review', evals: 'eval report' }[kind];
		if (own) {
			note(own, summary.reportPath);
		} else {
			note('report', summary.research && summary.research.reportPath);
			note('proposal', summary.proposal && summary.proposal.proposalPath);
			note('review', summary.review && summary.review.reviewPath);
		}
		showNote(`Run ${name}`, dir || '', lines.join('\n'), notes);
	} catch (error) {
		showNote('Run', '', error.message, []);
	}
}

/** Runs from before v0.5 have no kind in their summary: the folder name says it. */
function kindFromName(name) {
	if (name.endsWith('-evals')) {
		return 'evals';
	}
	if (name.endsWith('-pipeline')) {
		return 'pipeline';
	}
	if (/-proposal(-v\d+)?$/.test(name)) {
		return 'proposal';
	}
	if (/-review(-v\d+)?$/.test(name)) {
		return 'review';
	}
	return 'research';
}

async function openNote(label, path) {
	try {
		const note = await api(`/api/notes?path=${encodeURIComponent(path)}`);
		showNote(label, note.path, note.text, []);
	} catch (error) {
		showNote(label, path, error.message, []);
	}
}

function showNote(title, path, text, extras) {
	$('#note-card').hidden = false;
	$('#note-title').replaceChildren(title, ...extras.map((node) => el('span', {}, [' ', node])));
	$('#note-path').textContent = path;
	$('#note-text').textContent = text;
	$('#note-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- Jobs --------------------------------------------------------------------

let stream = null;

function watchJob(id) {
	if (stream) {
		stream.close();
	}
	const card = $('#job-card');
	const log = $('#job-log');
	card.hidden = false;
	log.textContent = '';
	$('#job-result').replaceChildren();
	setStatus('running');

	const query = token() ? `?token=${encodeURIComponent(token())}` : '';
	stream = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events${query}`);
	stream.onmessage = (event) => {
		log.textContent += `${JSON.parse(event.data)}\n`;
		log.scrollTop = log.scrollHeight;
	};
	stream.addEventListener('done', (event) => {
		stream.close();
		stream = null;
		const { job } = JSON.parse(event.data);
		setStatus(job.status);
		renderResult(job);
		$('#run-button').disabled = false;
		loadRuns().catch(() => undefined);
	});
	stream.onerror = () => {
		// EventSource reconnects on its own; a finished job replays its lines and ends again.
	};
}

function setStatus(status) {
	const node = $('#job-status');
	node.textContent = status;
	node.className = `pill ${status}`;
}

function renderResult(job) {
	const box = $('#job-result');
	box.replaceChildren();
	const line = (key, ...values) => box.append(el('div', { class: 'line' }, [el('span', { class: 'key' }, key), ...values]));
	if (job.status === 'failed') {
		line('error', job.error || 'The run failed.');
		return;
	}
	const result = job.result;
	if (!result) {
		return;
	}
	const noteButton = (label, path) => el('button', { class: 'link', onclick: () => openNote(label, path) }, label);
	const notes = [noteButton('report', result.reportPath)];
	if (result.proposalPath) {
		notes.push(noteButton('proposal', result.proposalPath));
	}
	if (result.reviewPath) {
		notes.push(noteButton('review', result.reviewPath));
	}
	notes.push(noteButton('client memory', result.memoryPath));
	line('notes', ...notes);
	if (result.verdict) {
		const findings = result.findings ? ` (${result.findings.high} high, ${result.findings.medium} medium, ${result.findings.low} low)` : '';
		const versions = result.verdicts && result.verdicts.length > 1 ? `, ${result.verdicts.length} versions: ${result.verdicts.join(' → ')}` : '';
		line('verdict', pill(result.verdict), `${findings}${versions}`);
	}
	if (result.totals) {
		line('total', `${money(result.totals.min, result.currency)} – ${money(result.totals.max, result.currency)}`);
	}
	line('run', `${result.steps} steps, ${result.fetches} pages fetched, ${duration(result.durationMs)}, ${result.usage.requests} requests, ${result.usage.inputTokens.toLocaleString('en-US')} tokens in, ${result.usage.outputTokens.toLocaleString('en-US')} out, cost ${cost(result.cost)}`);
	line('trace', el('span', { class: 'path' }, result.runDir));
}

$('#run-form').addEventListener('submit', async (event) => {
	event.preventDefault();
	const form = event.currentTarget;
	const data = Object.fromEntries(new FormData(form).entries());
	const message = $('#form-message');
	message.textContent = '';
	$('#run-button').disabled = true;
	try {
		const { job } = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
		message.textContent = `queued as ${job.id}`;
		watchJob(job.id);
	} catch (error) {
		message.textContent = error.message;
		$('#run-button').disabled = false;
	}
});

loadStatus();
loadRuns().catch((error) => {
	$('#runs-empty').hidden = false;
	$('#runs-empty').textContent = error.message;
});
