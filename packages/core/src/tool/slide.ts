import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { Tool } from './tool'

const SLIDE_SCRIPTS_DIR = path.resolve(__dirname, '../../../packages/opencode/src/slide/scripts');

function detectFormat(filePath: string): 'pptx' | 'pdf' | 'unknown' {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pptx' || ext === '.ppt') return 'pptx';
    if (ext === '.pdf') return 'pdf';
    return 'unknown';
}

export const slideAnalyzeTool: Tool = {
    name: 'slide_analyze',
    description: 'Analyzes a PPTX or PDF file to reverse engineer its structure, style, and content depth. Works for medical/surgical presentations and ebooks.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Absolute path to the .pptx or .pdf file' }
        },
        required: ['path']
    },
    execute: async ({ path: filePath }) => {
        try {
            const format = detectFormat(filePath);
            if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

            let script: string;
            let output = "";
            if (format === 'pptx') {
                script = path.join(SLIDE_SCRIPTS_DIR, 'extract_pptx.py');
                // Re-use the pptx extraction logic via a temporary output file
                const outputFile = path.join(SLIDE_SCRIPTS_DIR, `_pptx_output.md`);
                execSync(`python "${script}" "${filePath}" "${outputFile}"`, { encoding: 'utf8' });
                output = fs.readFileSync(outputFile, 'utf8');
                fs.unlinkSync(outputFile);
            } else if (format === 'pdf') {
                script = path.join(SLIDE_SCRIPTS_DIR, 'extract_pdf.py');
                const outputFile = path.join(SLIDE_SCRIPTS_DIR, `_pdf_output.md`);
                execSync(`python "${script}" "${filePath}" "${outputFile}"`, { encoding: 'utf8' });
                output = fs.readFileSync(outputFile, 'utf8');
                fs.unlinkSync(outputFile);
            } else {
                return `Error: Unsupported file format. Use .pptx or .pdf`;
            }

            // Parse outline, full text, and the precise citations block
            const outlineStart = output.indexOf("=== OUTLINE");
            const fullTextStart = output.indexOf("=== FULL TEXT ===");
            const citationsStart = output.indexOf("=== CITATIONS (JSON) ===");
            let outline = "";
            let fullText = "";
            let citations: any[] = [];
            if (outlineStart !== -1 && fullTextStart !== -1) {
                outline = output.substring(outlineStart, fullTextStart).split("===")[2] || "";
                fullText = output.substring(fullTextStart + "=== FULL TEXT ===".length);
                if (citationsStart !== -1 && citationsStart > fullTextStart) {
                    fullText = fullText.substring(0, citationsStart - (fullTextStart + "=== FULL TEXT ===".length));
                    try {
                        citations = JSON.parse(output.substring(citationsStart + "=== CITATIONS (JSON) ===".length).trim());
                    } catch { /* malformed JSON, skip */ }
                }
            }

            // Precision score: machine-verifiable IDs (PMID/DOI) give Thesis-AI-grade confidence
            const verifiable = citations.filter((c: any) => c.type === "PMID" || c.type === "DOI");

            return JSON.stringify({
                format,
                outline: outline.trim().split("\n").filter((l: string) => l.trim()),
                citations,
                precision: {
                    totalCitations: citations.length,
                    machineVerifiable: verifiable.length,
                    verifiedIDs: verifiable.map((c: any) => c.id),
                },
                fullTextPreview: fullText.substring(0, 5000) + (fullText.length > 5000 ? "..." : ""),
            }, null, 2);
        } catch (e: any) {
            return `Error analyzing slide: ${e.message}`;
        }
    }
};

export const slidePlanTool: Tool = {
    name: 'slide_plan',
    description: 'Creates a presentation plan based on a theme and an extracted Gold Standard profile. If no reference is given, uses the default Oncology Surgery profile for maximum quality.',
    parameters: {
        type: 'object',
        properties: {
            theme: { type: 'string', description: 'The theme of the new presentation' },
            format: { type: 'string', enum: ['pptx', 'pdf'], description: 'Target output format', default: 'pptx' },
            profile: { type: 'string', description: 'Optional profile name (e.g., surgeryOncology_pptx or medicalEbook_pdf)' }
        },
        required: ['theme']
    },
    execute: async ({ theme, format, profile }) => {
        try {
            // Dynamically import the service
            const { SlideService, PROFILES } = await import('../../../../packages/opencode/src/slide');
            const profileName = profile as keyof typeof PROFILES | undefined;
            const plan = SlideService.plan(theme, profileName);
            return JSON.stringify(plan, null, 2);
        } catch (e: any) {
            return `Error planning slide: ${e.message}`;
        }
    }
};

export const slideGenerateTool: Tool = {
    name: 'slide_generate',
    description: 'Generates detailed, high-quality slide content ("quality insana") based on a plan. The engine guarantees surgical specificity and academic rigor.',
    parameters: {
        type: 'object',
        properties: {
            plan: { type: 'string', description: 'The JSON output from slide_plan' }
        },
        required: ['plan']
    },
    execute: async ({ plan }) => {
        try {
            const { SlideService } = await import('../../../../packages/opencode/src/slide');
            const planJson = JSON.parse(plan);
            const generated = SlideService.generate(planJson);
            return JSON.stringify(generated, null, 2);
        } catch (e: any) {
            return `Error generating slide: ${e.message}`;
        }
    }
};
