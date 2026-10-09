import { describe, expect, it } from "vitest";

import { child, text, xmlRoot } from "../src/xml.ts";

const entities = (definitions: string, body: string) => `<?xml version="1.0"?><!DOCTYPE r [${definitions}]><r>${body}</r>`;

describe("xmlRoot", () => {
  it("decodes entities, numeric references and CDATA, and keeps values as text", () => {
    const root = xmlRoot("<r><a>1&#46;10</a><b>a&#x2F;b&amp;c</b><c><![CDATA[x<y]]></c></r>", "r");
    expect([text(child(root, "a")), text(child(root, "b")), text(child(root, "c"))]).toEqual(["1.10", "a/b&c", "x<y"]);
  });

  it("reads a tag padded with a long whitespace run in linear time", () => {
    const xml = `<r ${" ".repeat(1_000_000)}=><a>kept</a></r>`;
    const started = performance.now();
    expect(text(child(xmlRoot(xml, "r"), "a"))).toBe("kept");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses documents over the entity budgets", () => {
    const many = Array.from({ length: 51 }, (_, i) => `<!ENTITY e${i} "x">`).join("");
    expect(xmlRoot(entities(many, "<a>&e0;</a>"), "r")).toBeUndefined();
    expect(xmlRoot(entities(`<!ENTITY big "${"x".repeat(1_001)}">`, "<a>&big;</a>"), "r")).toBeUndefined();
    expect(xmlRoot(entities('<!ENTITY e "x">', `<a>${"&e;".repeat(1_001)}</a>`), "r")).toBeUndefined();
    // Within budget, a declared entity expands.
    expect(text(child(xmlRoot(entities('<!ENTITY e "x">', "<a>&e;&e;</a>"), "r"), "a"))).toBe("xx");
  });

  it("refuses reserved names, deep nesting and oversized documents, and a different root", () => {
    expect(xmlRoot("<r><__proto__>x</__proto__></r>", "r")).toBeUndefined();
    expect(xmlRoot(`<r>${"<a>".repeat(101)}${"</a>".repeat(101)}</r>`, "r")).toBeUndefined();
    expect(xmlRoot(`<r>${"x".repeat(5_000_001)}</r>`, "r")).toBeUndefined();
    expect(xmlRoot("<other/>", "r")).toBeUndefined();
    expect(xmlRoot("<r><a>cut</a>", "r")).toBeUndefined();
    expect(xmlRoot("<r><a>cut</a><!-- a comment -->", "r")).toBeUndefined();
    // Legal trailing content and a spaced closing tag still close the document.
    for (const tail of ["</r><!--generated-->", "</r>\n<?done?>\n", "</r >", "</r>\n<!-- a --> <?b?>"]) expect(text(child(xmlRoot(`<r><a>kept</a>${tail}`, "r"), "a"))).toBe("kept");
    expect(text(child(xmlRoot('<p:r xmlns:p="urn:x"><a>ns</a></p:r>\n', "r"), "a"))).toBe("ns");
  });
});
