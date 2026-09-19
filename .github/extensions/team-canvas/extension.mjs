import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const servers = new Map();
const columnDefinitions = [
    { id: "backlog", title: "Backlog", color: "#64748b" },
    { id: "todo", title: "To do", color: "#60a5fa" },
    { id: "in-progress", title: "In progress", color: "#f59e0b" },
    { id: "done", title: "Done", color: "#34d399" },
];

const defaultCards = [
    {
        id: "card-feature-flags",
        title: "Confirm feature flags",
        description: "Verify production defaults before the next release.",
        assignee: "Platform",
        priority: "High",
        urgency: "Release is approaching and an incorrect default could affect every user.",
    },
    {
        id: "card-analytics",
        title: "Review launch analytics",
        description: "Check dashboards and support escalations before launch.",
        assignee: "Product",
        priority: "Medium",
        urgency: "Launch decisions depend on this signal, and support escalations may indicate active impact.",
    },
    {
        id: "card-sprint-update",
        title: "Share sprint update",
        description: "Send the delivery update to stakeholders by Friday.",
        assignee: "Engineering",
        priority: "Low",
        urgency: "It has a near-term communication deadline but does not currently block delivery.",
    },
];

function createDefaultBoard(input = {}) {
    const projectName = typeof input.projectName === "string" && input.projectName.trim()
        ? input.projectName.trim()
        : "Engineering Team Canvas";
    const teamName = typeof input.teamName === "string" && input.teamName.trim()
        ? input.teamName.trim()
        : "Product & Engineering";

    const columns = columnDefinitions.map((column) => ({
        ...column,
        cards: column.id === "todo"
            ? defaultCards.map((card) => decorateCard(card, column.id))
            : [],
    }));

    return {
        title: projectName,
        teamName,
        columns,
        updatedAt: new Date().toISOString(),
    };
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function decorateCard(card, columnId) {
    const priority = ["High", "Medium", "Low"].includes(card.priority) ? card.priority : "Medium";
    const urgencyByPriority = {
        High: "High impact or time-sensitive work should be reviewed first.",
        Medium: "This work may affect near-term delivery and should be assessed before lower-risk items.",
        Low: "This is useful follow-up work, but it is less urgent than the active delivery risks.",
    };

    return {
        id: card.id,
        title: card.title,
        description: typeof card.description === "string" ? card.description : "",
        assignee: typeof card.assignee === "string" ? card.assignee : "",
        priority,
        urgency: typeof card.urgency === "string" && card.urgency.trim()
            ? card.urgency
            : urgencyByPriority[priority],
        columnId,
    };
}

function getCardScore(card) {
    const priorityScore = { High: 30, Medium: 20, Low: 10 };
    const columnScore = { "in-progress": 15, todo: 10, backlog: 0, done: -100 };
    return (priorityScore[card.priority] ?? 0) + (columnScore[card.columnId] ?? 0);
}

function getTriageCards(board) {
    return board.columns
        .flatMap((column) => column.cards)
        .map((card) => decorateCard(card, board.columns.find((column) => column.cards.includes(card))?.id ?? "backlog"))
        .filter((card) => card.columnId !== "done")
        .sort((first, second) => getCardScore(second) - getCardScore(first))
        .slice(0, 3);
}

function getBoardPath(instanceId) {
    const workspaceRoot = globalThis.__teamCanvasWorkspace
        ?? join(process.cwd(), ".github", "extensions", "team-canvas");
    return join(workspaceRoot, "artifacts", `board-${instanceId}.json`);
}

function normalizeBoard(parsed, input = {}) {
    const fallback = createDefaultBoard(input);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.columns)) {
        return fallback;
    }

    const columns = columnDefinitions.map((definition) => {
        const parsedColumn = parsed.columns.find((column) => column?.id === definition.id);
        const cards = Array.isArray(parsedColumn?.cards)
            ? parsedColumn.cards
                .filter((card) => card && typeof card.id === "string" && typeof card.title === "string")
                .map((card) => decorateCard(card, definition.id))
            : [];
        return { ...definition, cards };
    });

    return {
        title: typeof input.projectName === "string" && input.projectName.trim()
            ? input.projectName.trim()
            : typeof parsed.title === "string" && parsed.title.trim()
                ? parsed.title
                : fallback.title,
        teamName: typeof input.teamName === "string" && input.teamName.trim()
            ? input.teamName.trim()
            : typeof parsed.teamName === "string" && parsed.teamName.trim()
                ? parsed.teamName
                : fallback.teamName,
        columns,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
    };
}

async function loadBoard(instanceId, input = {}) {
    try {
        const raw = await fs.readFile(getBoardPath(instanceId), "utf8");
        return normalizeBoard(JSON.parse(raw), input);
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
        return createDefaultBoard(input);
    }
}

async function saveBoard(instanceId, board) {
    const boardPath = getBoardPath(instanceId);
    await fs.mkdir(join(boardPath, ".."), { recursive: true });
    await fs.writeFile(boardPath, JSON.stringify(board, null, 2), "utf8");
}

function pushUpdate(instanceId, board) {
    const entry = servers.get(instanceId);
    if (!entry) {
        return;
    }

    const payload = `data: ${JSON.stringify(board)}\n\n`;
    for (const response of entry.subscribers) {
        if (!response.writableEnded) {
            response.write(payload);
        }
    }
}

async function updateBoard(instanceId, mutator) {
    const board = await loadBoard(instanceId);
    mutator(board);
    board.updatedAt = new Date().toISOString();
    await saveBoard(instanceId, board);

    const entry = servers.get(instanceId);
    if (entry) {
        entry.board = board;
    }
    pushUpdate(instanceId, board);
    return board;
}

function findCard(board, cardId) {
    for (const column of board.columns) {
        const index = column.cards.findIndex((card) => card.id === cardId);
        if (index >= 0) {
            return { column, index, card: column.cards[index] };
        }
    }
    return undefined;
}

function moveCard(board, cardId, columnId) {
    const destination = board.columns.find((column) => column.id === columnId);
    const source = findCard(board, cardId);
    if (!destination || !source) {
        return false;
    }

    source.column.cards.splice(source.index, 1);
    source.card.columnId = destination.id;
    destination.cards.push(source.card);
    return true;
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("error", reject);
        request.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error("Invalid JSON request body"));
            }
        });
    });
}

function renderHtml(board) {
    const serializedBoard = JSON.stringify(board).replaceAll("<", "\\u003c");
    const initialColumns = board.columns.map((column) => `
      <section class="column" data-column-id="${escapeHtml(column.id)}">
        <header class="column-header">
          <div><span class="column-dot" style="background:${escapeHtml(column.color)}"></span><h2>${escapeHtml(column.title)}</h2></div>
          <span class="count">${column.cards.length}</span>
        </header>
        <div class="cards" data-card-list="${escapeHtml(column.id)}"></div>
      </section>`).join("");

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(board.title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --background-color-default: #0f172a;
        --background-color-muted: #111827;
        --border-color-default: #334155;
        --text-color-default: #e2e8f0;
        --text-color-muted: #94a3b8;
        --color-focus-outline: #60a5fa;
        --color-white: #f8fafc;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 15% 0%, rgba(59, 130, 246, 0.18), transparent 32%), var(--background-color-default); color: var(--text-color-default); font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); padding: 28px; }
      .panel { max-width: 1320px; margin: 0 auto; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-bottom: 24px; padding: 24px; border: 1px solid rgba(96, 165, 250, 0.24); border-radius: 20px; background: linear-gradient(135deg, rgba(30, 41, 59, 0.92), rgba(15, 23, 42, 0.74)); box-shadow: 0 18px 50px rgba(2, 6, 23, 0.28); }
      .eyebrow { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 10px; color: #93c5fd; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
      .eyebrow::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.13); }
      h1 { margin: 0 0 7px; font-size: clamp(26px, 4vw, 38px); letter-spacing: -0.035em; }
      h2 { margin: 0; font-size: 14px; }
      .subtitle, .hint { color: var(--text-color-muted); }
      .subtitle { margin: 0; font-size: 14px; }
      .header-meta { display: grid; justify-items: end; gap: 12px; color: var(--text-color-muted); font-size: 12px; }
      .live-pill { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid rgba(52, 211, 153, 0.3); border-radius: 999px; background: rgba(16, 185, 129, 0.1); color: #a7f3d0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
      .live-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #34d399; }
      .toolbar { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-bottom: 26px; padding: 14px; border: 1px solid rgba(51, 65, 85, 0.9); border-radius: 14px; background: rgba(15, 23, 42, 0.58); }
      form { display: flex; gap: 8px; flex-wrap: wrap; }
      input, select, button { font: inherit; border-radius: 9px; }
      input, select { min-height: 40px; background: rgba(15, 23, 42, 0.86); border: 1px solid var(--border-color-default); color: var(--text-color-default); padding: 8px 11px; transition: border-color 160ms ease, box-shadow 160ms ease; }
      input { flex: 1 1 220px; }
      button { min-height: 40px; border: 1px solid rgba(96, 165, 250, 0.7); background: linear-gradient(135deg, rgba(59, 130, 246, 0.42), rgba(37, 99, 235, 0.2)); color: var(--color-white); padding: 8px 14px; font-weight: 700; cursor: pointer; transition: transform 160ms ease, background 160ms ease, border-color 160ms ease; }
      button:hover { background: linear-gradient(135deg, rgba(96, 165, 250, 0.5), rgba(37, 99, 235, 0.3)); transform: translateY(-1px); }
      button:disabled { cursor: default; opacity: 0.8; transform: none; }
      button:focus-visible, input:focus-visible, select:focus-visible, .card:focus-visible { outline: 2px solid var(--color-focus-outline); outline-offset: 2px; }
      input:focus-visible, select:focus-visible { border-color: var(--color-focus-outline); box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.14); }
      .board { display: grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap: 14px; align-items: start; overflow-x: auto; padding-bottom: 6px; }
      .triage-section { margin-bottom: 30px; }
      .section-heading { margin: 0 0 7px; font-size: 21px; letter-spacing: -0.02em; }
      .section-description { margin: 0 0 12px; color: var(--text-color-muted); font-size: 13px; }
      .triage-grid { display: grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 14px; }
      .triage-card { position: relative; overflow: hidden; background: linear-gradient(145deg, rgba(30, 41, 59, 0.98), rgba(30, 64, 175, 0.22)); border: 1px solid rgba(96, 165, 250, 0.42); border-radius: 16px; padding: 18px; box-shadow: 0 12px 28px rgba(2, 6, 23, 0.2); transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease; }
      .triage-card::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, #60a5fa, #a78bfa); }
      .triage-card:hover { transform: translateY(-3px); border-color: rgba(147, 197, 253, 0.75); box-shadow: 0 18px 34px rgba(2, 6, 23, 0.3); }
      .triage-card .card-title { font-size: 16px; padding-right: 36px; }
      .rank { position: absolute; top: 15px; right: 15px; display: grid; place-items: center; width: 25px; height: 25px; border-radius: 8px; background: rgba(96, 165, 250, 0.2); color: #bfdbfe; font-size: 12px; font-weight: 800; }
      .why-now { margin: 0 0 14px; padding: 10px; border-radius: 9px; background: rgba(245, 158, 11, 0.12); color: #fde68a; font-size: 12px; line-height: 1.45; }
      .context-button { width: 100%; margin-top: 14px; }
      .context-button.added { border-color: rgba(52, 211, 153, 0.7); background: rgba(16, 185, 129, 0.18); }
      .remainder-heading { margin: 0 0 12px; font-size: 21px; letter-spacing: -0.02em; }
      .column { min-height: 420px; background: rgba(17, 24, 39, 0.72); border: 1px solid var(--border-color-default); border-radius: 16px; padding: 13px; box-shadow: 0 8px 24px rgba(2, 6, 23, 0.12); }
      .column.drag-over { border-color: var(--color-focus-outline); background: rgba(30, 41, 59, 0.9); }
      .column-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .column-header > div { display: flex; align-items: center; gap: 8px; }
      .column-dot { width: 9px; height: 9px; border-radius: 50%; }
      .count { min-width: 24px; padding: 3px 7px; text-align: center; border-radius: 999px; background: rgba(148, 163, 184, 0.15); color: var(--text-color-muted); font-size: 12px; }
      .cards { display: grid; gap: 10px; min-height: 360px; }
      .card { background: linear-gradient(145deg, #1e293b, #172033); border: 1px solid var(--border-color-default); border-radius: 12px; padding: 13px; cursor: grab; transition: border-color 160ms ease, transform 160ms ease; }
      .card:hover { border-color: rgba(96, 165, 250, 0.55); transform: translateY(-1px); }
      .card:active { cursor: grabbing; }
      .card-title { margin: 0 0 6px; font-size: 14px; font-weight: 700; }
      .card-description { margin: 0 0 12px; color: var(--text-color-muted); font-size: 12px; line-height: 1.45; }
      .card-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: var(--text-color-muted); font-size: 11px; }
      .priority { padding: 4px 8px; border-radius: 999px; background: rgba(96, 165, 250, 0.16); color: #bfdbfe; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
      .move-row { display: flex; gap: 5px; margin-top: 10px; }
      .move-row select { width: 100%; min-height: 32px; font-size: 11px; }
      .empty { border: 1px dashed var(--border-color-default); border-radius: 10px; color: var(--text-color-muted); padding: 18px 10px; text-align: center; font-size: 12px; background: rgba(15, 23, 42, 0.28); }
      @media (max-width: 900px) { body { padding: 16px; } .triage-grid { grid-template-columns: 1fr; } .board { grid-template-columns: repeat(4, minmax(250px, 1fr)); } .toolbar { grid-template-columns: 1fr; } .header { flex-direction: column; padding: 20px; } .header-meta { justify-items: start; } }
    </style>
  </head>
  <body>
    <main class="panel">
      <header class="header">
        <div>
          <div class="eyebrow">Live issue triage</div>
          <h1 id="board-title">${escapeHtml(board.title)}</h1>
          <p class="subtitle">${escapeHtml(board.teamName)} · Kanban board</p>
        </div>
        <div class="header-meta"><div class="live-pill">Live board</div><div id="updated-at">Updated ${escapeHtml(new Date(board.updatedAt).toLocaleString())}</div><div class="hint">Drag cards between columns</div></div>
      </header>
      <section class="toolbar" aria-label="Board controls">
        <form id="card-form">
          <input id="card-title" data-testid="kanban-card-title" name="title" required maxlength="120" placeholder="What needs to be done?" aria-label="Card title" />
          <input id="card-description" data-testid="kanban-card-description" name="description" maxlength="240" placeholder="Description (optional)" aria-label="Card description" />
          <input id="card-assignee" data-testid="kanban-card-assignee" name="assignee" maxlength="60" placeholder="Assignee" aria-label="Card assignee" />
          <select id="card-priority" data-testid="kanban-card-priority" name="priority" aria-label="Card priority"><option>High</option><option selected>Medium</option><option>Low</option></select>
          <button type="submit" data-testid="kanban-add-card">Add card</button>
        </form>
        <button id="reset-board" data-testid="kanban-reset-board" type="button">Reset board</button>
      </section>
      <section class="triage-section" aria-labelledby="triage-heading">
        <h2 id="triage-heading" class="section-heading">Needs attention now</h2>
        <p class="section-description">The three issues most likely to need action first, based on priority and whether they are already in progress.</p>
        <div id="triage-grid" class="triage-grid"></div>
      </section>
      <h2 class="remainder-heading">All remaining work</h2>
      <section class="board" aria-label="Kanban board">${initialColumns}</section>
    </main>
    <script>
      const initialBoard = ${serializedBoard};
      let board = initialBoard;
      const columns = ${JSON.stringify(columnDefinitions)};
      const contextCards = new Set();

      function getTriageCardsClient() {
        return board.columns
          .flatMap((column) => column.cards)
          .filter((card) => card.columnId !== 'done')
          .sort((first, second) => {
            const priority = { High: 30, Medium: 20, Low: 10 };
            const column = { 'in-progress': 15, todo: 10, backlog: 0 };
            return (priority[second.priority] || 0) + (column[second.columnId] || 0) - (priority[first.priority] || 0) - (column[first.columnId] || 0);
          })
          .slice(0, 3);
      }

      function render(nextBoard) {
        board = nextBoard;
        document.getElementById('board-title').textContent = board.title;
        document.getElementById('updated-at').textContent = 'Updated ' + new Date(board.updatedAt).toLocaleString();
        const triageCards = getTriageCardsClient();
        const triageIds = new Set(triageCards.map((card) => card.id));
        const triageGrid = document.getElementById('triage-grid');
        triageGrid.replaceChildren();
        if (!triageCards.length) {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'No open issues need attention right now.';
          triageGrid.append(empty);
        }
        triageCards.forEach((card) => {
          const element = document.createElement('article');
          element.className = 'triage-card';
          element.dataset.cardId = card.id;
          element.innerHTML = '<span class="rank"></span><h3 class="card-title"></h3><p class="card-description"></p><p class="why-now"><strong>Why it is top priority:</strong> <span></span></p><div class="card-footer"><span class="assignee"></span><span class="priority"></span></div><button class="context-button" type="button" data-testid="kanban-add-context"></button>';
          element.querySelector('.rank').textContent = '#' + (triageCards.indexOf(card) + 1);
          element.querySelector('.card-title').textContent = card.title;
          element.querySelector('.card-description').textContent = card.description || 'No description provided.';
          element.querySelector('.why-now span').textContent = card.urgency || 'This issue has the strongest current delivery signal.';
          element.querySelector('.assignee').textContent = card.assignee || 'Unassigned';
          element.querySelector('.priority').textContent = card.priority || 'Medium';
          const contextButton = element.querySelector('.context-button');
          contextButton.dataset.testid = 'kanban-add-context-' + card.id;
          const isAdded = contextCards.has(card.id);
          contextButton.textContent = isAdded ? 'Added to current context' : 'Add to current context';
          contextButton.classList.toggle('added', isAdded);
          contextButton.disabled = isAdded;
          contextButton.addEventListener('click', async () => {
            try {
              await request('/api/context/' + encodeURIComponent(card.id), {});
              contextCards.add(card.id);
              render(board);
            } catch (error) {
              window.alert('Unable to add issue to the current context.');
            }
          });
          triageGrid.append(element);
        });

        board.columns.forEach((column) => {
          const section = document.querySelector('[data-column-id="' + column.id + '"]');
          const list = section.querySelector('[data-card-list]');
          section.querySelector('.count').textContent = column.cards.filter((card) => !triageIds.has(card.id)).length;
          list.replaceChildren();
          if (!column.cards.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'Drop cards here';
            list.append(empty);
          }
          column.cards.filter((card) => !triageIds.has(card.id)).forEach((card) => {
            const element = document.createElement('article');
            element.className = 'card';
            element.draggable = true;
            element.tabIndex = 0;
            element.dataset.cardId = card.id;
            element.innerHTML = '<h3 class="card-title"></h3><p class="card-description"></p><div class="card-footer"><span class="assignee"></span><span class="priority"></span></div><div class="move-row"><select data-testid="kanban-move-card" aria-label="Move card"></select></div>';
            element.querySelector('.card-title').textContent = card.title;
            element.querySelector('.card-description').textContent = card.description || 'No description';
            element.querySelector('.assignee').textContent = card.assignee || 'Unassigned';
            element.querySelector('.priority').textContent = card.priority || 'Medium';
            const select = element.querySelector('select');
            columns.forEach((target) => {
              const option = document.createElement('option');
              option.value = target.id;
              option.textContent = 'Move to ' + target.title;
              option.selected = target.id === column.id;
              select.append(option);
            });
            select.addEventListener('change', () => moveCard(card.id, select.value));
            element.addEventListener('dragstart', (event) => {
              event.dataTransfer.setData('text/plain', card.id);
            });
            list.append(element);
          });
        });
      }

      async function request(path, body) {
        const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error('Request failed');
        return response.json();
      }

      async function moveCard(cardId, columnId) {
        try { render(await request('/api/cards/' + encodeURIComponent(cardId) + '/move', { columnId })); } catch (error) { window.alert('Unable to move card.'); }
      }

      document.getElementById('card-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
          render(await request('/api/cards', { title: form.get('title'), description: form.get('description'), assignee: form.get('assignee'), priority: form.get('priority') }));
          event.currentTarget.reset();
        } catch (error) { window.alert('Unable to add card.'); }
      });
      document.getElementById('reset-board').addEventListener('click', async () => {
        try { render(await request('/api/reset', {})); } catch (error) { window.alert('Unable to reset board.'); }
      });
      document.querySelectorAll('.column').forEach((column) => {
        column.addEventListener('dragover', (event) => { event.preventDefault(); column.classList.add('drag-over'); });
        column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
        column.addEventListener('drop', async (event) => {
          event.preventDefault();
          column.classList.remove('drag-over');
          await moveCard(event.dataTransfer.getData('text/plain'), column.dataset.columnId);
        });
      });
      const stream = new EventSource('/events');
      stream.onmessage = (event) => render(JSON.parse(event.data));
      render(board);
    </script>
  </body>
</html>`;
}

async function startServer(instanceId, board) {
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, "http://127.0.0.1");
            if (request.method === "GET" && url.pathname === "/events") {
                response.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                });
                response.write("retry: 1000\n\n");
                servers.get(instanceId).subscribers.add(response);
                request.on("close", () => servers.get(instanceId)?.subscribers.delete(response));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/cards") {
                const payload = await readJsonBody(request);
                const nextBoard = await updateBoard(instanceId, (current) => {
                    const title = typeof payload.title === "string" ? payload.title.trim() : "";
                    if (!title) return;
                    current.columns.find((column) => column.id === "todo").cards.push(decorateCard({
                        id: `card-${randomUUID()}`,
                        title,
                        description: typeof payload.description === "string" ? payload.description.trim() : "",
                        assignee: typeof payload.assignee === "string" ? payload.assignee.trim() : "",
                        priority: ["High", "Medium", "Low"].includes(payload.priority) ? payload.priority : "Medium",
                    }, "todo"));
                });
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify(nextBoard));
                return;
            }

            const moveMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/move$/);
            if (request.method === "POST" && moveMatch) {
                const payload = await readJsonBody(request);
                const nextBoard = await updateBoard(instanceId, (current) => {
                    moveCard(current, decodeURIComponent(moveMatch[1]), payload.columnId);
                });
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify(nextBoard));
                return;
            }

            const contextMatch = url.pathname.match(/^\/api\/context\/([^/]+)$/);
            if (request.method === "POST" && contextMatch) {
                const board = await loadBoard(instanceId);
                const cardId = decodeURIComponent(contextMatch[1]);
                const result = findCard(board, cardId);
                if (!result) {
                    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                    response.end("Issue not found");
                    return;
                }

                const card = decorateCard(result.card, result.column.id);
                await session.send({
                    prompt: [
                        "Add this issue to the current working context and help me get started on it:",
                        `Title: ${card.title}`,
                        `Description: ${card.description || "No description provided."}`,
                        `Priority: ${card.priority}`,
                        `Why it is flagged now: ${card.urgency}`,
                        `Current Kanban column: ${result.column.title}`,
                    ].join("\n"),
                });
                servers.get(instanceId)?.contextCards.add(cardId);
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ ok: true, cardId }));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/reset") {
                const nextBoard = createDefaultBoard();
                await saveBoard(instanceId, nextBoard);
                const entry = servers.get(instanceId);
                if (entry) entry.board = nextBoard;
                pushUpdate(instanceId, nextBoard);
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify(nextBoard));
                return;
            }

            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(renderHtml(board));
        } catch {
            response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Unable to process request");
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, subscribers: new Set(), contextCards: new Set(), board, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "team-canvas",
            displayName: "Team Kanban",
            description: "Persistent four-column Kanban board for the development team.",
            inputSchema: {
                type: "object",
                properties: {
                    projectName: { type: "string" },
                    teamName: { type: "string" },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "create_card",
                    description: "Create a card in the To do column.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            title: { type: "string", minLength: 1 },
                            description: { type: "string" },
                            assignee: { type: "string" },
                            priority: { type: "string", enum: ["High", "Medium", "Low"] },
                        },
                        required: ["title"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => updateBoard(ctx.instanceId, (board) => {
                        board.columns.find((column) => column.id === "todo").cards.push(decorateCard({
                            id: `card-${randomUUID()}`,
                            title: ctx.input.title.trim(),
                            description: ctx.input.description?.trim() ?? "",
                            assignee: ctx.input.assignee?.trim() ?? "",
                            priority: ctx.input.priority ?? "Medium",
                        }, "todo"));
                    }),
                },
                {
                    name: "move_card",
                    description: "Move an existing card to another Kanban column.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            cardId: { type: "string", minLength: 1 },
                            columnId: { type: "string", enum: ["backlog", "todo", "in-progress", "done"] },
                        },
                        required: ["cardId", "columnId"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => updateBoard(ctx.instanceId, (board) => {
                        moveCard(board, ctx.input.cardId, ctx.input.columnId);
                    }),
                },
                {
                    name: "reset_board",
                    description: "Reset the Kanban board to its starter cards.",
                    handler: async (ctx) => {
                        const board = createDefaultBoard();
                        await saveBoard(ctx.instanceId, board);
                        const entry = servers.get(ctx.instanceId);
                        if (entry) entry.board = board;
                        pushUpdate(ctx.instanceId, board);
                        return board;
                    },
                },
            ],
            open: async (ctx) => {
                const board = await loadBoard(ctx.instanceId, ctx.input ?? {});
                await saveBoard(ctx.instanceId, board);
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, board);
                    servers.set(ctx.instanceId, entry);
                }
                entry.board = board;
                return { title: board.title, url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;
                servers.delete(ctx.instanceId);
                entry.subscribers.clear();
                await new Promise((resolve) => entry.server.close(() => resolve()));
            },
        }),
    ],
});

if (session?.workspacePath) {
    globalThis.__teamCanvasWorkspace = session.workspacePath;
}
