import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { chunkSlideText, extractPptxText, numericFileOrder } from "../scripts/material-pipeline-utils.mjs";

test("PowerPoint slide files are ordered numerically", () => {
  assert.deepEqual(["slide10.xml", "slide2.xml", "slide1.xml"].sort(numericFileOrder), ["slide1.xml", "slide2.xml", "slide10.xml"]);
});

test("extractPptxText keeps slide order and notes", async () => {
  const zip = new JSZip();
  zip.file("ppt/slides/slide2.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Nội dung slide hai</a:t></p:sld>');
  zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Tiêu đề</a:t><a:t>Slide một</a:t></p:sld>');
  zip.file("ppt/notesSlides/notesSlide1.xml", '<p:notes xmlns:p="p" xmlns:a="a"><a:t>Ghi chú giảng viên</a:t></p:notes>');
  const slides = await extractPptxText(await zip.generateAsync({ type: "nodebuffer" }));
  assert.deepEqual(slides[0], { slideNumber: 1, text: "Tiêu đề Slide một", notes: "Ghi chú giảng viên" });
  assert.equal(slides[1].text, "Nội dung slide hai");
});

test("chunkSlideText preserves overlap and omits blanks", () => {
  const chunks = chunkSlideText("A".repeat(700) + ". " + "B".repeat(700), 800, 100);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 800));
  assert.deepEqual(chunkSlideText("   "), []);
});
