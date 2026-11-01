export async function runArchive({
  store,
  client,
  maxSeconds = 1800,
  maxDocuments = 2000,
  clock = Date.now,
  onProgress = () => {},
}) {
  if (
    !Number.isFinite(maxSeconds) ||
    maxSeconds < 1 ||
    !Number.isInteger(maxDocuments) ||
    maxDocuments < 1
  )
    throw new Error("Invalid archive run budget.");
  const started = clock(),
    deadline = started + maxSeconds * 1000;
  let fetched = 0,
    pages = 0,
    pending = 0,
    failure = null;
  store.manifest.lastRun = {
    startedAt: new Date(started).toISOString(),
    status: "running",
    fetched: 0,
    pages: 0,
  };
  await store.persist();
  if (
    store.manifest.nextSourceAttemptAt &&
    Date.parse(store.manifest.nextSourceAttemptAt) > clock()
  ) {
    store.manifest.lastRun.status = "waiting_retry";
    store.manifest.lastRun.finishedAt = new Date(clock()).toISOString();
    await store.persist();
    return store.manifest.lastRun;
  }
  while (clock() < deadline && fetched < maxDocuments) {
    const window = store.nextWindow(clock());
    if (!window) break;
    window.status = "active";
    try {
      const page = await client.search(
        window.from,
        window.to,
        window.tab,
        window.cursor.page,
        window.cursor.query,
        window.cursor.order,
      );
      pages++;
      if (page.page !== window.cursor.page)
        throw new Error(
          "The official source returned a different page than requested.",
        );
      window.sourceTotal = page.total;
      window.cursor.query = page.query;
      window.cursor.order = page.order;
      if (page.total === 0) {
        store.reconcile(window, 0);
        store.manifest.consecutiveSourceFailures = 0;
        store.manifest.nextSourceAttemptAt = null;
        await store.persist();
        continue;
      }
      while (
        window.cursor.nextDocument < page.documentIds.length &&
        clock() < deadline &&
        fetched < maxDocuments
      ) {
        const document = await client.document(
          page.documentIds[window.cursor.nextDocument],
          window.tab,
          page.query,
        );
        await store.record(window, document);
        window.cursor.nextDocument++;
        fetched++;
        pending++;
        store.manifest.consecutiveSourceFailures = 0;
        store.manifest.nextSourceAttemptAt = null;
        onProgress({
          reference: document.reference,
          date: document.date,
          window: window.id,
          fetched,
          uniqueInWindow: window.seenReferences.length,
          sourceCount: page.total,
        });
        if (pending >= 25) {
          store.manifest.lastRun.fetched = fetched;
          store.manifest.lastRun.pages = pages;
          await store.persist();
          pending = 0;
        }
      }
      if (window.cursor.nextDocument >= page.documentIds.length) {
        if (window.cursor.page < page.totalPages) {
          window.cursor.page++;
          window.cursor.nextDocument = 0;
        } else store.reconcile(window, page.total);
      }
      store.manifest.lastRun.fetched = fetched;
      store.manifest.lastRun.pages = pages;
      await store.persist();
      pending = 0;
    } catch (error) {
      store.fail(window, error, clock());
      store.manifest.consecutiveSourceFailures =
        (store.manifest.consecutiveSourceFailures || 0) + 1;
      store.manifest.nextSourceAttemptAt = new Date(
        clock() +
          Math.min(
            86400000,
            15 * 60000 * 2 ** (store.manifest.consecutiveSourceFailures - 1),
          ),
      ).toISOString();
      failure = String(error);
      break;
    }
  }
  const unfinished = store.manifest.windows.some(
    (w) => w.status !== "completed",
  );
  store.manifest.lastRun = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(clock()).toISOString(),
    status: failure
      ? "failed"
      : !unfinished
        ? "up_to_date"
        : store.nextWindow(clock())
          ? "paused"
          : store.manifest.windows.some(
                (w) => w.status !== "completed" && w.status !== "blocked",
              )
            ? "waiting_retry"
            : "blocked",
    fetched,
    pages,
    seconds: Math.round((clock() - started) / 1000),
    error: failure,
  };
  await store.persist();
  return store.manifest.lastRun;
}
