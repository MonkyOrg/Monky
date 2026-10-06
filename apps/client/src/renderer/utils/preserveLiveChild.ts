/**
 * Rebuild translated siblings without ever detaching a live iframe's ancestors.
 * Removing and reinserting an iframe would reload its document even with the same DOM node.
 */
export function replaceAroundLiveChild(container: HTMLElement, markup: string, rootSelector: string, childSelector: string): boolean {
  const root = container.querySelector<HTMLElement>(rootSelector);
  const child = root?.querySelector<HTMLElement>(childSelector);
  if (!root || !child) return false;
  const template = document.createElement('template');
  template.innerHTML = markup;
  const nextRoot = template.content.querySelector<HTMLElement>(rootSelector);
  const marker = nextRoot?.querySelector<HTMLElement>(childSelector);
  if (!nextRoot || !marker) return false;

  const ancestorPath = (descendant: HTMLElement, ancestor: HTMLElement): HTMLElement[] | null => {
    const path = [descendant];
    while (path.at(-1) !== ancestor) {
      const parent = path.at(-1)?.parentElement;
      if (!parent) return null;
      path.push(parent);
    }
    return path;
  };
  const currentPath = ancestorPath(child, root);
  const nextPath = ancestorPath(marker, nextRoot);
  if (!currentPath || !nextPath || currentPath.length !== nextPath.length) return false;

  for (let index = 1; index < currentPath.length; index++) {
    const parent = currentPath[index];
    const preserved = currentPath[index - 1];
    const nextParent = nextPath[index];
    const nextMarker = nextPath[index - 1];
    if (preserved.parentElement !== parent || nextMarker.parentElement !== nextParent) return false;
    for (const node of [...parent.childNodes]) if (node !== preserved) node.remove();
    let after = false;
    for (const node of [...nextParent.childNodes]) {
      if (node === nextMarker) after = true;
      else parent.insertBefore(node, after ? null : preserved);
    }
  }
  return true;
}
