export interface FolderNode {
  name: string;
  path: string;
  document_count: number;
  total_count: number;
  children: FolderNode[];
}

// The managed WeKnora cloud may not expose the folder-tree endpoint.
// Rebuild a read-only tree from knowledge.folder_path without fetching content.
export function buildFolderTree(folderPaths: string[]): FolderNode[] {
  const root: FolderNode[] = [];
  const nodes = new Map<string, FolderNode>();
  for (const raw of folderPaths) {
    if (typeof raw !== "string" || raw.length > 2048) continue;
    const segments = raw.replaceAll("\\", "/").split("/").filter(s => s && s !== ".");
    if (segments.length === 0 || segments.length > 32 || segments.some(s => s === "..")) continue;
    let prefix = "";
    let siblings = root;
    for (const [index, segment] of segments.entries()) {
      prefix = prefix ? prefix + "/" + segment : segment;
      let node = nodes.get(prefix);
      if (!node) {
        if (nodes.size >= 5000) throw new Error("Folder hierarchy too large to reconstruct safely");
        node = { name: segment, path: prefix, document_count: 0, total_count: 0, children: [] };
        nodes.set(prefix, node);
        siblings.push(node);
      }
      node.total_count += 1;
      siblings = node.children;
      if (index === segments.length - 1) node.document_count += 1;
    }
  }
  function sortChildren(items: FolderNode[]) {
    items.sort((a,b) => a.path.localeCompare(b.path));
    for (const item of items) sortChildren(item.children);
  }
  sortChildren(root);
  return root;
}
