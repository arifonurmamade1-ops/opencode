import { makeLocationNode } from "../effect/app-node";
import { Layer } from "effect";
import { slideAnalyzeTool, slidePlanTool, slideGenerateTool } from "./slide";

export const SlideAnalyzeTool = {
    node: makeLocationNode({
        name: "slide-analyze",
        layer: Layer.empty,
        deps: []
    }),
    tool: slideAnalyzeTool
};

export const SlidePlanTool = {
    node: makeLocationNode({
        name: "slide-plan",
        layer: Layer.empty,
        deps: []
    }),
    tool: slidePlanTool
};

export const SlideGenerateTool = {
    node: makeLocationNode({
        name: "slide-generate",
        layer: Layer.empty,
        deps: []
    }),
    tool: slideGenerateTool
};
