/**
 * Load more: the "Older stories" link on a news listing fetches the next
 * page's cards (the same URL with `?fragment=cards`) and appends them, so
 * readers stay in place. Without JavaScript, or if the fetch fails, the link
 * still goes to the next page.
 */
const FRAGMENT = "cards";

const loadMore = async (link: HTMLAnchorElement): Promise<void> => {
  const listing = link.closest("[data-news-listing]");
  const list = listing?.querySelector<HTMLUListElement>("[data-news-cards]");
  const nav = link.closest("nav");

  if (!(listing && list && nav)) {
    window.location.assign(link.href);

    return;
  }

  const url = new URL(link.href);
  url.searchParams.set("fragment", FRAGMENT);

  link.setAttribute("aria-busy", "true");
  link.textContent = "Loading…";

  try {
    const response = await fetch(url, { headers: { Accept: "text/html" } });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const fragment = new DOMParser().parseFromString(
      await response.text(),
      "text/html"
    );

    const cards = [
      ...fragment.querySelectorAll<HTMLLIElement>("[data-news-cards] > li"),
    ].map((card) => document.importNode(card, true));

    for (const card of cards) {
      // The Worker's own `Element` type, which this app also loads, narrows
      // `append` to HTMLRewriter content, so the DOM's Node method it is.
      // oxlint-disable-next-line unicorn/prefer-dom-node-append
      list.appendChild(card);
    }

    // The next page's own "Older stories" link, or none on the last page.
    const next = fragment.querySelector("[data-news-more]")?.closest("nav");

    if (next) {
      nav.replaceWith(document.importNode(next, true));
    } else {
      nav.remove();
    }

    // Keyboard and screen reader users land on the first new story.
    cards[0]?.querySelector<HTMLAnchorElement>("h2 a, h3 a")?.focus();
  } catch {
    window.location.assign(link.href);
  }
};

document.addEventListener("click", (event) => {
  const { target } = event;

  if (!(target instanceof Element)) {
    return;
  }

  const link = target.closest<HTMLAnchorElement>("a[data-news-more]");

  // Let modified clicks open the page in a new tab as usual.
  if (
    !link ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  event.preventDefault();
  void loadMore(link);
});
