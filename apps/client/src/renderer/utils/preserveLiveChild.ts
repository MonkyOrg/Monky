/**
 * Rebuild translated siblings without ever detaching a live iframe's ancestors.
 * Removing and reinserting an iframe would reload its document even with the same DOM node.
 */
export function replaceAroundLiveChild(container: HTMLElement, markup: string, rootSelector: string, childSelector: string): boolean {
  const root = container.querySelector<HTMLElement>(rootSelector);
  const child = root?.querySelector<HTMLElement>(childSelector);
  if (!root || !child || child.parentElement !== root) return false;
  const template = document.createElement('template');
  template.innerHTML = markup;
  const nextRoot = template.content.querySelector<HTMLElement>(rootSelector);
  const marker = nextRoot?.querySelector<HTMLElement>(childSelector);
  if (!nextRoot || marker?.parentElement !== nextRoot) return false;
  for (const node of [...root.childNodes]) if (node !== child) node.remove();
  let after = false;
  for (const node of [...nextRoot.childNodes]) {
    if (node === marker) after = true;
    else root.insertBefore(node, after ? null : child);
  }
  return true;
}
