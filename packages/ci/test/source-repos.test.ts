import { describe, expect, it } from "vitest";

import { pomParent, pomRepository } from "../src/source-repos.ts";

const pkg = { ecosystem: "Maven" as const, name: "com.acme:lib", version: "1.0.0" };
const project = (body: string, attributes = 'xmlns="http://maven.apache.org/POM/4.0.0"') => `<?xml version="1.0"?>\n<project ${attributes}>${body}</project>`;

describe("pomRepository", () => {
  it("reads the project's scm url, then its connections, then its own url", () => {
    expect(pomRepository(project("<scm><url>https://github.com/acme/lib</url></scm>"), pkg)).toBe("acme/lib");
    expect(pomRepository(project("<scm><connection>scm:git:git@github.com:acme/conn.git</connection></scm>"), pkg)).toBe("acme/conn");
    expect(pomRepository(project("<url>https://github.com/acme/site</url>"), pkg)).toBe("acme/site");
  });

  it("reads only the project's own sections, not a profile's or a plugin's", () => {
    const pom = project(`
      <profiles><profile><id>fork</id><scm><url>https://github.com/fork/lib</url></scm><properties><repo>fork/lib</repo></properties></profile></profiles>
      <build><plugins><plugin><configuration><url>https://github.com/plugin/thing</url></configuration></plugin></plugins></build>
      <properties><repo>acme/lib</repo></properties>
      <scm><url>https://github.com/\${repo}</url></scm>`);
    expect(pomRepository(pom, pkg)).toBe("acme/lib");
  });

  it("decodes CDATA and entities and joins text a comment splits", () => {
    expect(pomRepository(project("<scm><url><![CDATA[https://github.com/acme/cdata]]></url></scm>"), pkg)).toBe("acme/cdata");
    expect(pomRepository(project("<scm><url>https://github.com/acme/lib?a=1&amp;b=2</url></scm>"), pkg)).toBe("acme/lib");
    expect(pomRepository(project("<scm><url>https://github.com/ac<!-- note -->me/lib</url></scm>"), pkg)).toBe("acme/lib");
  });

  it("works without a namespace, and names nothing for a POM that isn't well-formed", () => {
    expect(pomRepository(project("<scm><url>https://github.com/acme/lib</url></scm>", ""), pkg)).toBe("acme/lib");
    expect(pomRepository("<project><scm><url>https://github.com/acme/lib</url></scm>", pkg)).toBeUndefined();
    expect(pomRepository("<metadata><url>https://github.com/acme/lib</url></metadata>", pkg)).toBeUndefined();
  });
});

describe("reading hostile POMs", () => {
  it("refuses deep nesting quickly instead of parsing it", () => {
    let open = "", close = "";
    for (let i = 0; i < 16_000; i++) { open += `<a${i} xmlns:p${i}="urn:${i}">`; close = `</a${i}>` + close; }
    const started = performance.now();
    expect(pomRepository(project(`<scm><url>https://github.com/acme/lib</url></scm><build><plugins><plugin><configuration>${open}${close}</configuration></plugin></plugins></build>`), pkg)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("reads nothing from reserved names, entity bombs or oversized documents", () => {
    expect(pomRepository(project("<scm><url>https://github.com/acme/lib</url></scm><properties><__proto__>x</__proto__></properties>"), pkg)).toBeUndefined();
    const bomb = '<?xml version="1.0"?><!DOCTYPE project [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]><project><url>https://github.com/acme/&f;</url></project>';
    expect(pomRepository(bomb, pkg)).toBeUndefined();
    expect(pomRepository(project(`<scm><url>https://github.com/acme/lib</url></scm><description>${"x".repeat(5_000_001)}</description>`), pkg)).toBeUndefined();
  });

  it("lets the project's properties override the built-in ones, as Maven does", () => {
    expect(pomRepository(project("<properties><artifactId>other</artifactId></properties><scm><url>https://github.com/acme/${artifactId}</url></scm>"), pkg)).toBe("acme/other");
  });
});

describe("pomParent", () => {
  it("reads the project's parent, never a dependency's coordinates", () => {
    const pom = project(`
      <dependencies><dependency><groupId>org.other</groupId><artifactId>dep</artifactId><version>9</version></dependency></dependencies>
      <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>2</version></parent>`);
    expect(pomParent(pom)).toEqual({ ecosystem: "Maven", name: "com.acme:parent", version: "2" });
    expect(pomParent(project("<parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>${v}</version></parent>"))).toBeUndefined();
    expect(pomParent(project(""))).toBeUndefined();
  });
});
