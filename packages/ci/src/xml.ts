/**
 * Reading Maven's XML (POMs, `maven-metadata.xml`) as data, with fast-xml-parser under fixed
 * budgets: a size cap, its nesting limit, and DOCTYPE entities kept few, small and rarely
 * expanded (none is fetched: nothing external is read). Entities, numeric character references
 * and CDATA are decoded, comments dropped, namespace prefixes ignored, every value kept as text
 * (`1.10` stays `1.10`). A document over budget, or using reserved names such as `__proto__`,
 * reads as nothing, and so does one whose root doesn't close at the end (a truncated download).
 * Otherwise reading is tolerant: there's no separate well-formedness validation (fast-xml-parser's
 * validator is quadratic on long whitespace runs inside a tag).
 */
import { XMLParser } from "fast-xml-parser";

/** An element: its text, or its child elements by name (in document order per name) and `#text`. */
export type XmlElement = string | { readonly [name: string]: ReadonlyArray<XmlElement> | string };

/** POMs and Maven metadata are kilobytes; anything near this is hostile or broken. */
const MAX_XML_LENGTH = 5_000_000;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: () => true,
  maxNestedTags: 100,
  // Numeric character references (`&#46;`) are decoded through the HTML entity table.
  htmlEntities: true,
  processEntities: { maxEntityCount: 50, maxEntitySize: 1_000, maxTotalExpansions: 1_000, maxExpandedLength: 100_000 },
});

/** The document's root element when it's named `root` (any namespace); undefined when it isn't, or the XML can't be read. */
export function xmlRoot(xml: string, root: string): XmlElement | undefined {
  if (xml.length > MAX_XML_LENGTH) return undefined;
  if (!closesAtEnd(xml, root)) return undefined;
  try {
    const document = parser.parse(xml) as Record<string, ReadonlyArray<XmlElement>>;
    return document[root]?.[0];
  } catch {
    return undefined;
  }
}

/** The element's own child elements with their names; text-only elements have none. */
export function children(parent: XmlElement | undefined): Array<[name: string, element: XmlElement]> {
  if (parent === undefined || typeof parent === "string") return [];
  return Object.entries(parent).flatMap(([name, value]) => name === "#text" || typeof value === "string" ? [] : value.map((element) => [name, element] as [string, XmlElement]));
}

/** The first own child element named `name` (any namespace). */
export function child(parent: XmlElement | undefined, name: string): XmlElement | undefined {
  return children(parent).find(([childName]) => childName === name)?.[1];
}

/** The element's own text, trimmed; undefined when absent or blank. */
export function text(element: XmlElement | undefined): string | undefined {
  const value = typeof element === "string" ? element : typeof element?.["#text"] === "string" ? element["#text"] : undefined;
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Whether the root's closing tag ends the document, past any trailing whitespace, comments and
 * processing instructions: a truncated download must not read as a shorter document. Linear.
 */
function closesAtEnd(xml: string, root: string): boolean {
  let end = xml.trimEnd();
  for (;;) {
    const [open, close] = end.endsWith("-->") ? ["<!--", "-->"] : end.endsWith("?>") ? ["<?", "?>"] : [];
    if (open === undefined) break;
    const start = end.lastIndexOf(open, end.length - close!.length - 1);
    if (start === -1) return false;
    end = end.slice(0, start).trimEnd();
  }
  return new RegExp(`</(?:[\\w.-]+:)?${root}\\s*>$`).test(end.slice(-300));
}
