const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3476;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const MAX_ROWS = Number(process.env.MAX_ROWS) || 200;

const REMOTE_POLL_MS = Number(process.env.REMOTE_POLL_MS) || 30000;

const SOURCES = {
  tasks: {
    title: "Tasks",
    path:
      process.env.TARGET_TASKS ||
      path.resolve(__dirname, "../src/overrides/tasks.json5"),
    parser: parseTasks,
  },
  hideout: {
    title: "Hideout",
    path:
      process.env.TARGET_HIDEOUT ||
      path.resolve(__dirname, "../src/overrides/hideout.json5"),
    parser: parseGeneric,
  },
  items: {
    title: "Items",
    path:
      process.env.TARGET_ITEMS ||
      path.resolve(__dirname, "../src/overrides/items.json5"),
    parser: parseGeneric,
  },
  traders: {
    title: "Traders",
    path:
      process.env.TARGET_TRADERS ||
      path.resolve(__dirname, "../src/overrides/traders.json5"),
    parser: parseGeneric,
  },
};

const stateByType = {
  tasks: { summary: null, updatedAt: null, error: null },
  hideout: { summary: null, updatedAt: null, error: null },
  items: { summary: null, updatedAt: null, error: null },
  traders: { summary: null, updatedAt: null, error: null },
};
const readLocks = {
  tasks: { isReading: false, pendingRead: false },
  hideout: { isReading: false, pendingRead: false },
  items: { isReading: false, pendingRead: false },
  traders: { isReading: false, pendingRead: false },
};
const clientsByType = new Map([
  ["tasks", new Set()],
  ["hideout", new Set()],
  ["items", new Set()],
  ["traders", new Set()],
]);

function isRemotePath(targetPath) {
  return /^https?:\/\//i.test(targetPath);
}

function normalizeRemoteUrl(input) {
  if (!input) {
    return input;
  }
  if (input.includes("github.com") && input.includes("/blob/")) {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const blobIndex = parts.indexOf("blob");
    if (blobIndex > -1) {
      const owner = parts[0];
      const repo = parts[1];
      const branch = parts[blobIndex + 1];
      const filePath = parts.slice(blobIndex + 2).join("/");
      if (owner && repo && branch && filePath) {
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
      }
    }
  }
  return input;
}

function fetchRemoteText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      res.setEncoding("utf8");
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve(data);
      });
    });
    request.on("error", reject);
  });
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safeJoin(base, requestPath) {
  const normalized = path.normalize(path.join(base, requestPath));
  if (!normalized.startsWith(base)) {
    return null;
  }
  return normalized;
}

function serveStatic(res, requestPath) {
  const filePath = safeJoin(PUBLIC_DIR, requestPath);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";

    send(res, 200, data, contentType);
  });
}

function parseTaskName(commentLine) {
  const text = commentLine.trim();
  const lower = text.toLowerCase();
  if (
    !text ||
    lower.startsWith("proof:") ||
    lower.startsWith("verified") ||
    lower.startsWith("tarkov.dev") ||
    !text.includes(" - ")
  ) {
    return null;
  }
  const parts = text.split(" - ").map((part) => part.trim());
  if (parts.length <= 1) {
    return text;
  }
  return parts.slice(0, -1).join(" - ");
}

function parseEntityName(commentLine) {
  const text = commentLine.trim();
  const lower = text.toLowerCase();
  if (
    !text ||
    lower.startsWith("proof:") ||
    lower.startsWith("format:") ||
    lower.startsWith("tarkov.dev") ||
    lower.startsWith("verified")
  ) {
    return null;
  }
  if (text.startsWith("[") && text.includes("]")) {
    return text.slice(1, text.indexOf("]")).trim();
  }
  if (text.includes(" - ")) {
    return text.split(" - ")[0].trim();
  }
  return text;
}

function cleanOldValue(value) {
  let cleaned = value.trim();
  const splitIndex = cleaned.search(/\s{2,}\w[\w-]*\s*:/);
  if (splitIndex > -1) {
    cleaned = cleaned.slice(0, splitIndex).trim();
  }
  if (cleaned.includes("//")) {
    cleaned = cleaned.split("//")[0].trim();
  }
  return cleaned.trim();
}

function normalizeValue(raw) {
  let cleaned = raw.trim().replace(/,$/, "");
  if (
    (cleaned.startsWith("\"") && cleaned.endsWith("\"")) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

function extractFieldMatches(line, field) {
  const regex = new RegExp(
    `${field}\\s*:\\s*([^,]+),?\\s*\\/\\/\\s*Was:\\s*([^\\n]+)`,
    "g",
  );
  const matches = [];
  let match = regex.exec(line);
  while (match) {
    matches.push({
      newValue: normalizeValue(match[1]),
      oldValue: normalizeValue(cleanOldValue(match[2])),
    });
    match = regex.exec(line);
  }
  return matches;
}

function createSection(title, columns) {
  return {
    title,
    columns,
    rows: [],
    truncated: false,
  };
}

function pushRow(section, row) {
  if (section.rows.length >= MAX_ROWS) {
    section.truncated = true;
    return;
  }
  section.rows.push(row);
}

function parseGeneric(text, label) {
  const section = createSection(`${label} Corrections`, [
    "Entity",
    "Field",
    "tarkov.dev",
    "Correct",
  ]);

  let lastEntityName = null;
  let currentEntityName = null;
  let currentEntityId = null;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const commentIndex = line.indexOf("//");
    const comment = commentIndex >= 0 ? line.slice(commentIndex + 2) : "";
    const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
    const trimmedCode = code.trim();

    if (line.trim().startsWith("//")) {
      const possibleName = parseEntityName(comment);
      if (possibleName) {
        lastEntityName = possibleName;
      }
    }

    const idMatch = code.match(/"([a-f0-9]{24})"\s*:\s*{/i);
    if (idMatch) {
      currentEntityId = idMatch[1];
      currentEntityName = lastEntityName || `ID ${currentEntityId}`;
    }

    if (!trimmedCode || !line.includes("Was:")) {
      continue;
    }

    const fieldRegex = /(\w+)\s*:\s*([^,]+),?\s*\/\/\s*Was:\s*([^\n]+)/g;
    let match = fieldRegex.exec(line);
    while (match) {
      const field = match[1];
      const newValue = normalizeValue(match[2]);
      const oldValue = normalizeValue(cleanOldValue(match[3]));
      pushRow(section, [
        currentEntityName || `ID ${currentEntityId || "?"}`,
        field,
        oldValue,
        newValue,
      ]);
      match = fieldRegex.exec(line);
    }
  }

  return [section];
}

function parseTasks(text) {
  const experienceSection = createSection("Task Experience Corrections", [
    "Task",
    "tarkov.dev",
    "Correct",
  ]);
  const objectiveSection = createSection("Task Objective Count Corrections", [
    "Task",
    "tarkov.dev",
    "Correct",
  ]);
  const rewardSection = createSection("Task Reward Corrections", [
    "Task",
    "Field",
    "tarkov.dev",
    "Correct",
  ]);
  const prereqSection = createSection("Task Prerequisite Corrections", [
    "Task",
    "Change",
  ]);
  const nameLinkSection = createSection("Task Name/Link Corrections", [
    "Task",
    "Field",
    "tarkov.dev",
    "Correct",
  ]);
  const levelSection = createSection("Task Level Requirements Corrections", [
    "Task",
    "Field",
    "tarkov.dev",
    "Correct",
  ]);

  let depth = 0;
  let lastTaskName = null;
  let currentTaskName = null;
  let currentTaskId = null;
  let objectivesDepth = null;
  let finishRewardsDepth = null;
  let taskRequirementsDepth = null;
  let requirementNames = [];
  let rewardItemName = null;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const commentIndex = line.indexOf("//");
    const comment = commentIndex >= 0 ? line.slice(commentIndex + 2) : "";
    const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
    const trimmedCode = code.trim();

    if (line.trim().startsWith("//")) {
      const possibleName = parseTaskName(comment);
      if (possibleName) {
        lastTaskName = possibleName;
      }
    }

    const idMatch = code.match(/"([a-f0-9]{24})"\s*:\s*{/i);
    if (idMatch) {
      currentTaskId = idMatch[1];
      currentTaskName = lastTaskName || `Task ID ${currentTaskId}`;
    }

    if (trimmedCode.startsWith("objectives:")) {
      objectivesDepth = depth;
    }
    if (trimmedCode.startsWith("finishRewards:")) {
      finishRewardsDepth = depth;
      rewardItemName = null;
    }
    if (trimmedCode.startsWith("taskRequirements:")) {
      taskRequirementsDepth = depth;
      requirementNames = [];
    }

    if (finishRewardsDepth !== null && trimmedCode.includes("name:")) {
      const nameMatch = trimmedCode.match(/name:\s*"([^"]+)"/);
      if (nameMatch) {
        rewardItemName = nameMatch[1];
      }
    }

    const experienceMatches = extractFieldMatches(line, "experience");
    experienceMatches.forEach((match) => {
      pushRow(experienceSection, [
        currentTaskName || `Task ID ${currentTaskId || "?"}`,
        match.oldValue,
        match.newValue,
      ]);
    });

    const minLevelMatches = extractFieldMatches(line, "minPlayerLevel");
    minLevelMatches.forEach((match) => {
      pushRow(levelSection, [
        currentTaskName || `Task ID ${currentTaskId || "?"}`,
        "minPlayerLevel",
        match.oldValue,
        match.newValue,
      ]);
    });

    const nameMatches = extractFieldMatches(line, "name");
    nameMatches.forEach((match) => {
      if (finishRewardsDepth !== null) {
        return;
      }
      pushRow(nameLinkSection, [
        currentTaskName || `Task ID ${currentTaskId || "?"}`,
        "name",
        match.oldValue,
        match.newValue,
      ]);
    });

    const linkMatches = extractFieldMatches(line, "wikiLink");
    linkMatches.forEach((match) => {
      pushRow(nameLinkSection, [
        currentTaskName || `Task ID ${currentTaskId || "?"}`,
        "wikiLink",
        match.oldValue,
        match.newValue,
      ]);
    });

    const countMatches = extractFieldMatches(line, "count");
    if (countMatches.length > 0) {
      if (objectivesDepth !== null && finishRewardsDepth === null) {
        countMatches.forEach((match) => {
          pushRow(objectiveSection, [
            currentTaskName || `Task ID ${currentTaskId || "?"}`,
            match.oldValue,
            match.newValue,
          ]);
        });
      } else if (finishRewardsDepth !== null) {
        countMatches.forEach((match) => {
          pushRow(rewardSection, [
            currentTaskName || `Task ID ${currentTaskId || "?"}`,
            rewardItemName ? `${rewardItemName} count` : "count",
            match.oldValue,
            match.newValue,
          ]);
        });
      }
    }

    if (taskRequirementsDepth !== null && trimmedCode.includes("name:")) {
      const reqNameMatch = trimmedCode.match(/name:\s*"([^"]+)"/);
      if (reqNameMatch) {
        requirementNames.push(reqNameMatch[1]);
      }
    }

    if (
      taskRequirementsDepth !== null &&
      trimmedCode.startsWith("],") &&
      comment.includes("Was:")
    ) {
      const oldValue = normalizeValue(cleanOldValue(comment.split("Was:")[1] || ""));
      const newValue = requirementNames.length
        ? requirementNames.join(", ")
        : "[]";
      const changeText = `taskRequirements changed from ${oldValue} to ${newValue}`;
      pushRow(prereqSection, [
        currentTaskName || `Task ID ${currentTaskId || "?"}`,
        changeText,
      ]);
    }

    const delta =
      (code.match(/{/g) || []).length +
      (code.match(/\[/g) || []).length -
      (code.match(/}/g) || []).length -
      (code.match(/]/g) || []).length;
    depth += delta;

    if (objectivesDepth !== null && depth <= objectivesDepth) {
      objectivesDepth = null;
    }
    if (finishRewardsDepth !== null && depth <= finishRewardsDepth) {
      finishRewardsDepth = null;
      rewardItemName = null;
    }
    if (taskRequirementsDepth !== null && depth <= taskRequirementsDepth) {
      taskRequirementsDepth = null;
      requirementNames = [];
    }
  }

  return [
    experienceSection,
    objectiveSection,
    rewardSection,
    prereqSection,
    nameLinkSection,
    levelSection,
  ];
}

function getState(type) {
  return {
    type,
    title: SOURCES[type].title,
    filePath: SOURCES[type].path,
    updatedAt: stateByType[type].updatedAt,
    sections: stateByType[type].summary,
    error: stateByType[type].error,
  };
}

function broadcast(type, event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const clients = clientsByType.get(type) || new Set();
  clients.forEach((client) => {
    client.write(message);
  });
}

async function refreshSnapshot(type) {
  const lock = readLocks[type];
  if (!lock) {
    return;
  }
  if (lock.isReading) {
    lock.pendingRead = true;
    return;
  }

  lock.isReading = true;
  try {
    const target = SOURCES[type];
    let raw = "";
    let updatedAt = null;

    if (isRemotePath(target.path)) {
      const remoteUrl = normalizeRemoteUrl(target.path);
      raw = await fetchRemoteText(remoteUrl);
      updatedAt = new Date().toISOString();
    } else {
      const [fileRaw, stats] = await Promise.all([
        fs.promises.readFile(target.path, "utf8"),
        fs.promises.stat(target.path),
      ]);
      raw = fileRaw;
      updatedAt = stats.mtime.toISOString();
    }
    const sections = target.parser(raw, target.title);
    stateByType[type].summary = sections;
    stateByType[type].updatedAt = updatedAt;
    stateByType[type].error = null;
    broadcast(type, "summary", getState(type));
  } catch (error) {
    stateByType[type].error = error.message || "Unable to read target file";
    broadcast(type, "error", getState(type));
  } finally {
    lock.isReading = false;
    if (lock.pendingRead) {
      lock.pendingRead = false;
      refreshSnapshot(type);
    }
  }
}

Object.entries(SOURCES).forEach(([type, source]) => {
  if (isRemotePath(source.path)) {
    setInterval(() => {
      refreshSnapshot(type);
    }, REMOTE_POLL_MS);
  } else {
    fs.watchFile(source.path, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        refreshSnapshot(type);
      }
    });
  }
  refreshSnapshot(type);
});

function normalizeType(type) {
  if (type && SOURCES[type]) {
    return type;
  }
  return "tasks";
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.method) {
    send(res, 400, "Bad request");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;

  if (req.method !== "GET") {
    send(res, 405, "Method not allowed");
    return;
  }

  if (pathname === "/latest") {
    const type = normalizeType(requestUrl.searchParams.get("type"));
    send(
      res,
      200,
      JSON.stringify(getState(type)),
      "application/json; charset=utf-8",
    );
    return;
  }

  if (pathname === "/events") {
    const type = normalizeType(requestUrl.searchParams.get("type"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`event: summary\ndata: ${JSON.stringify(getState(type))}\n\n`);
    const clients = clientsByType.get(type) || new Set();
    clients.add(res);
    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  if (
    pathname === "/" ||
    pathname === "/tasks" ||
    pathname === "/hideout" ||
    pathname === "/items" ||
    pathname === "/traders"
  ) {
    serveStatic(res, "/index.html");
    return;
  }

  const filePath = pathname;
  serveStatic(res, filePath);
});

let currentPort = PORT;

function startServer(port) {
  currentPort = port;
  server.listen(port, () => {
    const address = server.address();
    const activePort =
      typeof address === "object" && address !== null ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`Overlay monitor running at http://localhost:${activePort}`);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.warn(
      `Port ${currentPort} in use, retrying on a random available port...`,
    );
    // Retry on an ephemeral port assigned by the OS
    startServer(0);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("Failed to start overlay monitor:", error);
});

startServer(currentPort);
