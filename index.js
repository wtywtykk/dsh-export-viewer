// @wtywtykk/dsh-export-viewer — Host half.
//
// Serves one document-relative download route that turns the selected Session
// (plus all of its subagent descendants) into a single self-contained HTML
// page. The page template, stylesheet, renderer, and Markdown engine all live
// in this package's `assets/` directory; nothing is read from the workspace.
import { readFileSync } from 'node:fs';
import { buildViewer, renderViewerHtml, embedMarkdownMedia } from './viewer-model.js';

/** Absolute registration path; the browser addresses it document-relative. */
export const SESSION_VIEWER_PATH = '/api/session.viewer';

/** Services this Host half needs before it can serve the route. */
export const inject = ['connection'];

/** Read the bundled page assets for one request (small files; edits take effect immediately). */
function pageAssets() {
  const read = (name) => readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');
  return {
    page: read('page.html'),
    css: read('styles.css'),
    app: read('app.js'),
    markdown: read('markdown.js'),
  };
}

const text = (body, status, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...extra } });

/** One safe download filename from a Session id. */
function downloadName(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'session';
  return `dsh-session-${safe}.html`;
}

/** Deep-collect descendant snapshots from a lineage trace, breadth-first by lineage order. */
async function readDescendants(sessionQuery, nodes, out, seen, signal) {
  for (const node of nodes) {
    signal?.throwIfAborted();
    const id = node.session.header.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const snapshot = await sessionQuery.readSession(id);
    out.push(snapshot);
    await readDescendants(sessionQuery, node.descendants ?? [], out, seen, signal);
  }
}

/** Content arrays the viewer actually renders, with the event-specific path. */
function renderedContents(event) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'user/message':
      return [d.content];
    case 'system/message':
    case 'assistant/message':
    case 'tool/result':
      return [d.message?.content];
    case 'agent/inbox/spliced':
      return (d.inserted ?? []).map((m) => m.content);
    default:
      return [];
  }
}

/** Collect unique image attachment references from the snapshots the page renders. */
function collectImageRefs(snapshots) {
  const refs = new Map();
  const walk = (content) => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'image' && item.attachment) refs.set(String(item.attachment.attachmentId), item.attachment);
      else if (Array.isArray(item.content)) walk(item.content);
    }
  };
  for (const snapshot of snapshots) {
    for (const event of snapshot.events) {
      for (const content of renderedContents(event)) walk(content);
    }
  }
  return refs;
}

/** Total raw image bytes embedded in one page; beyond this the image is skipped. */
const MAX_EMBEDDED_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Read every referenced image through the attachment service and encode it as a data URL.
 * @param ctx - Host context carrying `attachments`.
 * @param snapshots - the root and descendant snapshots.
 * @param signal - request cancellation.
 * @returns `attachmentId -> data URL` for the images that were readable and within budget.
 */
async function embedImages(ctx, snapshots, signal) {
  const map = new Map();
  const attachments = ctx.get('attachments');
  if (attachments === undefined) return map;
  let bytes = 0;
  for (const ref of collectImageRefs(snapshots).values()) {
    signal?.throwIfAborted();
    if (bytes + (ref.bytes ?? 0) > MAX_EMBEDDED_IMAGE_BYTES) continue;
    try {
      const stored = await attachments.readImage(ref, signal);
      const base64 = Buffer.from(stored.data).toString('base64');
      map.set(String(ref.attachmentId), `data:${ref.mediaType};base64,${base64}`);
      bytes += ref.bytes ?? stored.data.byteLength;
    } catch {
      // A missing or unreadable image must not fail the whole export.
    }
  }
  return map;
}

/**
 * Build the exported HTML for one Session request.
 * @param ctx - Host context.
 * @param request - authenticated Fetch request with `sessionId` and optional `includeDescendants`.
 * @returns an HTML download response.
 */
async function viewerResponse(ctx, request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get('sessionId');
  if (sessionId === null || sessionId.length === 0) return text('missing sessionId query parameter', 400);
  const includeDescendants = url.searchParams.get('includeDescendants') !== 'false';

  const sessionQuery = ctx.get('sessionQuery');
  if (sessionQuery === undefined) return text('session viewer export is unavailable: missing session-query service', 500);

  try {
    request.signal.throwIfAborted();
    const rootSnapshot = await sessionQuery.readSession(sessionId);
    const childSnapshots = [];
    if (includeDescendants) {
      const trace = await sessionQuery.traceSession(sessionId, request.signal);
      await readDescendants(sessionQuery, trace.descendants ?? [], childSnapshots, new Set([String(sessionId)]), request.signal);
    }
    request.signal.throwIfAborted();

    const imageMap = await embedImages(ctx, [rootSnapshot, ...childSnapshots], request.signal);
    request.signal.throwIfAborted();
    const viewer = buildViewer(rootSnapshot, childSnapshots, imageMap);
    const media = embedMarkdownMedia(viewer, rootSnapshot.session.cwd);
    if (Object.keys(media).length) viewer.media = media;
    const html = renderViewerHtml(viewer, pageAssets());
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${downloadName(sessionId)}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof Error && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      return text('session not found', 404);
    }
    return text('session viewer export failed to read the stored log', 500);
  }
}

/**
 * Register the viewer download route.
 * @param ctx - Host context carrying Connection and session-query.
 */
export function apply(ctx) {
  const connection = Reflect.get(ctx, 'connection');
  if (connection === undefined) throw new Error('@wtywtykk/dsh-export-viewer requires the connection service');
  connection.fetch.register({
    path: SESSION_VIEWER_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await viewerResponse(ctx, request);
      if (request.method === 'GET') return response;
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    },
  });
}
