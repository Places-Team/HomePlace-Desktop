import { invoke } from "@tauri-apps/api/core";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import type { Language } from "../lib/i18n";
import "../styles/ideas-board.css";

type IdeaCategory = { id: string; name: string; position: number };
type Idea = { id: string; categoryId: string; title: string; note: string; pinned: boolean; archived: boolean; completedAt?: string | null; createdAt: string; updatedAt: string };
type IdeaPage = { categories: IdeaCategory[]; ideas: Idea[]; nextCursor: string | null };
type LegacyIdea = { id: string; title: string; category: string; createdAt: string };
type ContextAction = { label: string; icon: IconName; disabled?: boolean; danger?: boolean; run: () => void };
type Props = {
  language: Language;
  activeServerId: string | null;
  onOpenConnections: () => void;
  onMakeReminder: (title: string) => void;
  openContextMenu: (event: MouseEvent<HTMLElement>, actions: ContextAction[]) => void;
};

function errorText(error: unknown): string {
  return typeof error === "string" && error.trim() ? error : "HomePlace could not save the idea.";
}

function legacyData() {
  try {
    const raw = JSON.parse(window.localStorage.getItem("homeplace-ideas") ?? "[]") as unknown;
    const categoriesRaw = JSON.parse(window.localStorage.getItem("homeplace-idea-categories") ?? "[]") as unknown;
    const categories = Array.isArray(categoriesRaw) ? categoriesRaw.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.trim().length <= 40).slice(0, 40) : [];
    const ideas = Array.isArray(raw) ? raw.filter((item): item is LegacyIdea => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return typeof value.id === "string" && /^[a-f0-9-]{36}$/i.test(value.id)
        && typeof value.title === "string" && value.title.trim().length > 0 && value.title.trim().length <= 500
        && typeof value.category === "string" && value.category.trim().length > 0 && value.category.trim().length <= 40
        && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt));
    }) : [];
    return { ideas, categories };
  } catch {
    return { ideas: [] as LegacyIdea[], categories: [] as string[] };
  }
}

export function IdeasBoard({ language, activeServerId, onOpenConnections, onMakeReminder, openContextMenu }: Props) {
  const ru = language === "ru";
  const [page, setPage] = useState<IdeaPage>({ categories: [], ideas: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filterId, setFilterId] = useState("");
  const [archived, setArchived] = useState(false);
  const [completedOnly, setCompletedOnly] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [editing, setEditing] = useState<Idea | null>(null);
  const [viewing, setViewing] = useState<Idea | null>(null);
  const [composeExpanded, setComposeExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null);
  const [deleteIdeaId, setDeleteIdeaId] = useState<string | null>(null);
  const [importPrompt, setImportPrompt] = useState(false);
  const [legacy] = useState(legacyData);
  const [legacyImported, setLegacyImported] = useState(() => !!activeServerId && window.localStorage.getItem(`homeplace-ideas-imported:${activeServerId}`) === "1");
  const listVersion = useRef(0);

  const parameters = useCallback((cursor?: string) => ({ cursor: cursor ?? null, query: searchQuery || null, categoryId: filterId || null, archived, completed: archived ? null : completedOnly }), [searchQuery, filterId, archived, completedOnly]);
  const refresh = useCallback(async (quiet = false) => {
    if (!activeServerId) return;
    const version = ++listVersion.current;
    if (!quiet) setLoading(true);
    try {
      const data = await invoke<IdeaPage>("list_ideas", parameters());
      if (version !== listVersion.current) return;
      setPage(data);
      setError(null);
    } catch (reason) {
      if (version === listVersion.current) setError(errorText(reason));
    } finally {
      if (version === listVersion.current) setLoading(false);
    }
  }, [activeServerId, parameters]);

  useEffect(() => {
    if (!activeServerId || busy || editing) return;
    const update = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [activeServerId, busy, editing, refresh]);

  useEffect(() => {
    if (!activeServerId) return;
    let cancelled = false;
    const version = ++listVersion.current;
    invoke<IdeaPage>("list_ideas", parameters())
      .then((data) => { if (!cancelled && version === listVersion.current) { setPage(data); setError(null); } })
      .catch((reason) => { if (!cancelled && version === listVersion.current) setError(errorText(reason)); })
      .finally(() => { if (!cancelled && version === listVersion.current) setLoading(false); });
    return () => { cancelled = true; listVersion.current += 1; };
  }, [activeServerId, parameters]);

  async function mutate<T = unknown>(action: string, payload: Record<string, unknown>): Promise<T | null> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<T>("mutate_ideas", { action, payload });
      await refresh();
      return result;
    } catch (reason) {
      setError(errorText(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!page.nextCursor || busy) return;
    const version = listVersion.current;
    setBusy(true);
    try {
      const next = await invoke<IdeaPage>("list_ideas", parameters(page.nextCursor));
      if (version !== listVersion.current) return;
      setPage((current) => ({ categories: next.categories, ideas: [...current.ideas, ...next.ideas.filter((item) => !current.ideas.some((loaded) => loaded.id === item.id))], nextCursor: next.nextCursor }));
    } catch (reason) {
      if (version === listVersion.current) setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  function editIdea(idea: Idea) {
    setViewing(null);
    setEditing(idea);
    setComposeExpanded(true);
    setTitle(idea.title);
    setNote(idea.note);
    setCategoryId(idea.categoryId);
    setDeleteIdeaId(null);
  }

  function clearEditor() {
    setEditing(null);
    setComposeExpanded(false);
    setTitle("");
    setNote("");
    setCategoryId(archived ? "" : filterId);
  }

  async function saveIdea(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    const saved = await mutate(editing ? "updateIdea" : "createIdea", { ...(editing ? { id: editing.id } : {}), title: trimmed, note, ...(categoryId ? { categoryId } : {}) });
    if (saved) clearEditor();
  }

  async function addCategory(event: FormEvent) {
    event.preventDefault();
    const label = newCategory.trim();
    if (!label) return;
    const result = await mutate<{ category: IdeaCategory }>("createCategory", { name: label });
    if (result) { setNewCategory(""); setCategoryId(result.category.id); setPage((current) => ({ ...current, ideas: [], nextCursor: null })); setFilterId(result.category.id); setLoading(true); }
  }

  async function importLocal() {
    if (!activeServerId || busy) return;
    setBusy(true);
    setError(null);
    try {
      let imported = 0;
      const items = legacy.ideas;
      const batches = Math.max(1, Math.ceil(items.length / 30));
      for (let index = 0; index < batches; index += 1) {
        const group = items.slice(index * 30, (index + 1) * 30);
        const response = await invoke<{ imported: number }>("mutate_ideas", { action: "import", payload: {
          categories: index === 0 ? legacy.categories : [],
          ideas: group.map((item) => ({ sourceId: item.id, title: item.title.trim(), category: item.category.trim(), createdAt: new Date(item.createdAt).toISOString() })),
        } });
        imported += response.imported;
      }
      window.localStorage.setItem(`homeplace-ideas-imported:${activeServerId}`, "1");
      setLegacyImported(true);
      setImportPrompt(false);
      setNotice(ru ? `Перенесено ${imported} идей. Локальная копия сохранена.` : `Imported ${imported} ideas. The local copy was kept.`);
      await refresh();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  function selectSection(nextId: string, nextArchived: boolean, nextCompleted = false) {
    if (filterId === nextId && archived === nextArchived && completedOnly === nextCompleted) {
      void refresh();
      return;
    }
    listVersion.current += 1;
    setViewing(null);
    setFilterId(nextId);
    setArchived(nextArchived);
    setCompletedOnly(nextCompleted);
    setCategoryId(nextArchived ? "" : nextId);
    setPage((current) => ({ ...current, ideas: [], nextCursor: null }));
    setLoading(true);
  }

  async function toggleCompleted(idea: Idea) {
    const saved = await mutate("updateIdea", { id: idea.id, completed: !idea.completedAt });
    if (!saved) return;
    if (viewing?.id === idea.id) setViewing(null);
    if (editing?.id === idea.id) clearEditor();
  }

  function contextActions(idea: Idea): ContextAction[] {
    return [
      { label: ru ? "Открыть" : "Open", icon: "open", run: () => setViewing(idea) },
      { label: idea.completedAt ? (ru ? "Вернуть в работу" : "Mark as open") : (ru ? "Отметить сделанным" : "Mark done"), icon: "check", run: () => void toggleCompleted(idea) },
      { label: ru ? "Редактировать" : "Edit", icon: "edit", run: () => editIdea(idea) },
      { label: idea.pinned ? (ru ? "Открепить" : "Unpin") : (ru ? "Закрепить" : "Pin"), icon: "idea", run: () => void mutate("updateIdea", { id: idea.id, pinned: !idea.pinned }) },
      { label: idea.archived ? (ru ? "Вернуть из архива" : "Restore") : (ru ? "В архив" : "Archive"), icon: "refresh", run: () => void mutate("updateIdea", { id: idea.id, archived: !idea.archived }) },
      { label: ru ? "Сделать напоминанием" : "Turn into reminder", icon: "calendar", run: () => onMakeReminder(idea.title) },
      { label: ru ? "Дублировать" : "Duplicate", icon: "plus", run: () => void mutate("createIdea", { title: idea.title, note: idea.note, categoryId: idea.categoryId }) },
      { label: ru ? "Копировать текст" : "Copy text", icon: "clipboard", run: () => void navigator.clipboard.writeText(idea.title + (idea.note ? `\n\n${idea.note}` : "")) },
      { label: ru ? "Удалить" : "Delete", icon: "trash", danger: true, run: () => setDeleteIdeaId(idea.id) },
    ];
  }

  if (!activeServerId) return <article className="glass-card ideas-board"><div className="ideas-heading"><div><span className="ideas-kicker">HOMEPLACE</span><h3>{ru ? "Идеи" : "Ideas"}</h3><p>{ru ? "Привяжите компьютер, чтобы идеи сохранялись в вашем аккаунте." : "Pair this computer to save ideas to your account."}</p></div><button type="button" className="ideas-secondary" onClick={onOpenConnections}>{ru ? "Подключения" : "Connections"}</button></div></article>;

  const categoriesById = new Map(page.categories.map((item) => [item.id, item.name]));
  const needsPermission = error?.includes("not approved") || error?.includes("ideas.manage");
  return <article className="glass-card ideas-board">
    <div className="ideas-heading"><div><span className="ideas-kicker">HOMEPLACE / {ru ? "ЛИЧНОЕ" : "PERSONAL"}</span><h3>{ru ? "Идеи" : "Ideas"}</h3><p>{ru ? "Сохраняются в вашем аккаунте и доступны связанным устройствам." : "Saved to your account for approved devices."}</p></div><button type="button" className="ideas-secondary" onClick={() => void refresh()} disabled={loading || busy}><Icon name="refresh" size={15} />{ru ? "Обновить" : "Refresh"}</button></div>
    {error && <div className="ideas-message error" role="status"><span>{needsPermission ? (ru ? "Для синхронизации идей повторно привяжите компьютер и одобрите разрешение ideas.manage." : "Pair this computer again and approve ideas.manage to sync ideas.") : error}</span>{needsPermission && <button type="button" onClick={onOpenConnections}>{ru ? "Подключения" : "Connections"}</button>}</div>}
    {notice && <div className="ideas-message" role="status">{notice}</div>}
    {(legacy.ideas.length > 0 || legacy.categories.length > 0) && <div className="ideas-legacy"><div><b>{legacyImported ? (ru ? "Локальная копия идей сохранена" : "Your local idea copy is retained") : (ru ? "Есть идеи, сохранённые только на этом компьютере" : "Local ideas found on this computer")}</b><small>{ru ? `${legacy.ideas.length} идей · ${legacy.categories.length} разделов. Повторный перенос безопасен.` : `${legacy.ideas.length} ideas · ${legacy.categories.length} sections. Re-importing is safe.`}</small></div><button type="button" onClick={() => setImportPrompt(true)}>{legacyImported ? (ru ? "Повторить перенос" : "Re-import") : (ru ? "Перенести" : "Import")}</button></div>}
    {importPrompt && <div className="ideas-confirm"><p>{ru ? "Перенести локальные идеи в текущий аккаунт HomePlace? Повторный импорт не создаст дубликаты. Локальная копия останется на компьютере." : "Import local ideas into the current HomePlace account? Repeating this import will not create duplicates. The local copy stays on this computer."}</p><button type="button" onClick={() => setImportPrompt(false)}>{ru ? "Отмена" : "Cancel"}</button><button type="button" disabled={busy} onClick={() => void importLocal()}>{busy ? "…" : (ru ? "Перенести в аккаунт" : "Import to account")}</button></div>}
    <div className="ideas-layout">
      <aside className="ideas-sections" aria-label={ru ? "Разделы идей" : "Idea sections"}><div className="ideas-sections-title"><b>{ru ? "Разделы" : "Sections"}</b><small>{page.categories.length}</small></div><button type="button" className={!filterId && !archived && !completedOnly ? "active" : ""} onClick={() => selectSection("", false)}>{ru ? "Все идеи" : "All ideas"}</button>{page.categories.map((category) => <div className="ideas-section-row" key={category.id}><button type="button" className={filterId === category.id && !archived && !completedOnly ? "active" : ""} onClick={() => selectSection(category.id, false)}>{category.name}</button><button type="button" className="ideas-section-edit" aria-label={ru ? `Изменить раздел ${category.name}` : `Edit section ${category.name}`} onClick={() => { setRenamingId(category.id); setRenameValue(category.name); setDeleteCategoryId(null); }}><Icon name="edit" size={13} /></button></div>)}<button type="button" className={completedOnly ? "active" : ""} onClick={() => selectSection("", false, true)}>{ru ? "Сделано" : "Done"}</button><button type="button" className={archived ? "active" : ""} onClick={() => selectSection("", true)}>{ru ? "Архив" : "Archive"}</button><form className="ideas-add-section" onSubmit={(event) => void addCategory(event)}><input aria-label={ru ? "Новый раздел" : "New section"} placeholder={ru ? "Новый раздел" : "New section"} value={newCategory} onChange={(event) => setNewCategory(event.target.value)} maxLength={40} /><button type="submit" disabled={!newCategory.trim() || busy} aria-label={ru ? "Добавить раздел" : "Add section"}>+</button></form>
        {renamingId && <form className="ideas-rename" onSubmit={async (event) => { event.preventDefault(); if (!renameValue.trim()) return; const saved = await mutate("renameCategory", { id: renamingId, name: renameValue.trim() }); if (saved) setRenamingId(null); }}><label>{ru ? "Название раздела" : "Section name"}<input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} maxLength={40} /></label><div><button type="button" onClick={() => setRenamingId(null)}>{ru ? "Отмена" : "Cancel"}</button><button type="submit" disabled={!renameValue.trim() || busy}>{ru ? "Сохранить" : "Save"}</button></div><button type="button" className="ideas-danger-link" onClick={() => setDeleteCategoryId(renamingId)}>{ru ? "Удалить раздел" : "Delete section"}</button>{deleteCategoryId === renamingId && <p>{ru ? "Идеи перейдут во «Входящие»." : "Ideas will move to Inbox."}<button type="button" disabled={busy} onClick={async () => { const deleted = await mutate("deleteCategory", { id: renamingId }); if (deleted) { setRenamingId(null); setDeleteCategoryId(null); setFilterId(""); } }}>{ru ? "Подтвердить" : "Confirm"}</button></p>}</form>}
      </aside>
      <div className="ideas-main" aria-busy={loading}><form className={`ideas-compose${composeExpanded ? " expanded" : ""}`} onSubmit={(event) => void saveIdea(event)}><div className="ideas-compose-head"><b>{editing ? (ru ? "Редактирование" : "Edit idea") : (ru ? "Новая идея" : "New idea")}</b>{composeExpanded && <button type="button" onClick={clearEditor}>{ru ? "Закрыть" : "Close"}</button>}</div><div className="ideas-compose-primary"><input aria-label={ru ? "Название идеи" : "Idea title"} placeholder={ru ? "Что хотите сохранить?" : "What do you want to keep?"} value={title} onFocus={() => setComposeExpanded(true)} onChange={(event) => setTitle(event.target.value)} maxLength={500} /><button type="submit" disabled={!title.trim() || busy}>{busy ? "…" : editing ? (ru ? "Сохранить" : "Save") : (ru ? "Добавить" : "Add")}</button></div>{composeExpanded && <><textarea aria-label={ru ? "Заметка к идее" : "Idea note"} placeholder={ru ? "Детали, ссылка или следующий шаг — необязательно" : "Details, a link, or the next step — optional"} value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={editing ? 4 : 2} /><div className="ideas-compose-actions"><select aria-label={ru ? "Раздел" : "Section"} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">Inbox</option>{page.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><small>{ru ? "Идея сохранится в вашем аккаунте" : "Saved to your account"}</small></div></>}</form>
        <form className="ideas-search" onSubmit={(event) => { event.preventDefault(); const value = searchDraft.trim(); if (value === searchQuery) void refresh(); else { listVersion.current += 1; setPage((current) => ({ ...current, ideas: [], nextCursor: null })); setSearchQuery(value); setLoading(true); } }}><input aria-label={ru ? "Поиск идей" : "Search ideas"} placeholder={ru ? "Поиск по идеям и заметкам" : "Search ideas and notes"} value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} maxLength={100} /><button type="submit">{ru ? "Найти" : "Search"}</button>{searchQuery && <button type="button" onClick={() => { listVersion.current += 1; setSearchDraft(""); setPage((current) => ({ ...current, ideas: [], nextCursor: null })); setSearchQuery(""); setLoading(true); }}>{ru ? "Сбросить" : "Clear"}</button>}</form>
        {loading && page.ideas.length === 0 ? <p className="ideas-empty">{ru ? "Загружаем идеи…" : "Loading ideas…"}</p> : page.ideas.length === 0 ? <p className="ideas-empty">{completedOnly ? (ru ? "Завершённых идей пока нет." : "No completed ideas yet.") : archived ? (ru ? "В архиве пока пусто." : "The archive is empty.") : searchQuery ? (ru ? "По запросу ничего не найдено." : "No ideas match this search.") : (ru ? "Здесь пока пусто. Запишите первую идею выше." : "Nothing here yet. Capture your first idea above.")}</p> : <div className="ideas-list">{page.ideas.map((idea) => <div className={`ideas-item${viewing?.id === idea.id || editing?.id === idea.id ? " selected" : ""}`} key={idea.id} onContextMenu={(event) => openContextMenu(event, contextActions(idea))}><button type="button" className="ideas-item-body" onClick={() => setViewing(idea)}><span className="ideas-item-title">{idea.pinned && <Icon name="idea" size={15} />}<b>{idea.title}</b></span>{idea.note && <span className="ideas-item-note">{idea.note}</span>}<small>{categoriesById.get(idea.categoryId) ?? "Inbox"} · {new Date(idea.updatedAt).toLocaleDateString(ru ? "ru-RU" : "en-US")}</small></button><button type="button" className={`ideas-item-complete${idea.completedAt ? " done" : ""}`} aria-label={idea.completedAt ? (ru ? `Вернуть в работу: ${idea.title}` : `Mark as open: ${idea.title}`) : (ru ? `Отметить сделанным: ${idea.title}` : `Mark done: ${idea.title}`)} title={idea.completedAt ? (ru ? "Вернуть в работу" : "Mark as open") : (ru ? "Отметить сделанным" : "Mark done")} disabled={busy} onClick={() => void toggleCompleted(idea)}><Icon name="check" size={15} /></button><button type="button" className="ideas-item-menu" aria-label={ru ? `Действия с идеей ${idea.title}` : `Actions for ${idea.title}`} onClick={(event) => openContextMenu(event, contextActions(idea))}>···</button>{deleteIdeaId === idea.id && <div className="ideas-inline-delete"><span>{ru ? "Удалить эту идею?" : "Delete this idea?"}</span><button type="button" onClick={() => setDeleteIdeaId(null)}>{ru ? "Нет" : "No"}</button><button type="button" disabled={busy} onClick={async () => { const deleted = await mutate("deleteIdea", { id: idea.id }); if (deleted) { setDeleteIdeaId(null); if (viewing?.id === idea.id) setViewing(null); if (editing?.id === idea.id) clearEditor(); } }}>{ru ? "Удалить" : "Delete"}</button></div>}</div>)}</div>}
        {page.nextCursor && <button type="button" className="ideas-load-more" disabled={busy} onClick={() => void loadMore()}>{ru ? "Показать ещё" : "Show more"}</button>}
        {viewing && <article className="ideas-detail" aria-label={ru ? "Открытая идея" : "Open idea"}>
          <div className="ideas-detail-heading"><span>{categoriesById.get(viewing.categoryId) ?? "Inbox"} · {new Date(viewing.updatedAt).toLocaleDateString(ru ? "ru-RU" : "en-US")}</span><button type="button" onClick={() => setViewing(null)} aria-label={ru ? "Закрыть идею" : "Close idea"}>×</button></div>
          <h4>{viewing.title}</h4>
          {viewing.note ? <p>{viewing.note}</p> : <p className="ideas-detail-empty">{ru ? "Заметка не добавлена." : "No note added."}</p>}
          <div className="ideas-detail-actions"><button type="button" disabled={busy} onClick={() => editIdea(viewing)}><Icon name="edit" size={15} />{ru ? "Редактировать" : "Edit"}</button><button type="button" disabled={busy} onClick={() => void toggleCompleted(viewing)}><Icon name="check" size={15} />{viewing.completedAt ? (ru ? "Вернуть в работу" : "Mark as open") : (ru ? "Сделано" : "Done")}</button><button type="button" disabled={busy} onClick={() => void mutate("updateIdea", { id: viewing.id, pinned: !viewing.pinned }).then((saved) => { if (saved) setViewing({ ...viewing, pinned: !viewing.pinned }); })}><Icon name="pin" size={15} />{viewing.pinned ? (ru ? "Открепить" : "Unpin") : (ru ? "Закрепить" : "Pin")}</button></div>
        </article>}
      </div>
    </div>
  </article>;
}
