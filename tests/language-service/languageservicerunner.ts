/// <reference path="../../built/pxtcompiler.d.ts"/>


import * as fs from 'fs';
import * as path from 'path';

import "mocha";
import * as chai from "chai";

import * as util from "../common/testUtils";

const casesDir = path.join(process.cwd(), "tests", "language-service", "cases");
const testPackage = path.relative(process.cwd(), path.join("tests", "language-service", "test-package"));

interface CompletionTestCase {
    fileName: string;
    fileText: string;
    lineText: string;
    isPython: boolean;
    position: number;
    wordStartPos: number;
    wordEndPos: number;
    expectedSymbols: string[];
    unwantedSymbols: string[];
}

function initGlobals() {
    let g = global as any
    g.pxt = pxt;
    g.ts = ts;
    g.pxtc = pxtc;
    g.btoa = (str: string) => Buffer.from(str, "binary").toString("base64");
    g.atob = (str: string) => Buffer.from(str, "base64").toString("binary");
}

initGlobals();
pxt.setAppTarget(util.testAppTarget);

describe("language service", () => {
    const cases = getTestCases();

    for (const testCase of cases) {
        it("get completions " + testCase.fileName + testCase.position, () => {
            return runCompletionTestCaseAsync(testCase);
        });
    }
})

function getTestCases() {
    let filenames: string[] = [];
    for (const file of fs.readdirSync(casesDir)) {
        // ignore hidden files
        if (file[0] == ".") {
            continue;
        }

        // ignore files that start with TODO_; these represent future work
        if (file.indexOf("TODO") >= 0) {
            console.log("Skipping test file marked as 'TODO': " + file);
            continue;
        }

        const ext = file.substr(-3)
        if (ext !== ".ts" && ext !== ".py") {
            console.error("Skipping unknown/unsupported file in test folder: " + file);
            continue;
        }

        const filename = path.join(casesDir, file);

        // if a file is named "ONLY", only run that one file
        // (this is useful for working on a specific test case when
        // the test suite gets large)
        if (file.indexOf("ONLY") >= 0) {
            filenames = [filename]
            break;
        }

        filenames.push(filename);
    };

    const testCases: CompletionTestCase[] = [];

    for (const fileName of filenames) {
        const fileText = fs.readFileSync(fileName, { encoding: "utf8" });
        const isPython = fileName.substr(-3) !== ".ts";

        const lines = fileText.split("\n");
        let position = 0;

        for (const line of lines) {
            const commentString = isPython ? "#" : "//";
            const commentIndex = line.indexOf(commentString);
            if (commentIndex !== -1) {
                const comment = line.substr(commentIndex + commentString.length).trim();
                const symbols = comment.split(";")
                    .map(s => s.trim())
                const expectedSymbols = symbols
                    .filter(s => s.indexOf("!") === -1)
                const unwantedSymbols = symbols
                    .filter(s => s.indexOf("!") !== -1)
                    .map(s => s.replace("!", ""))

                const lineWithoutCommment = line.substring(0, commentIndex);

                // find last non-whitespace character
                let lastNonWhitespace: number;
                let endsInDot = false;
                for (let i = lineWithoutCommment.length - 1; i >= 0; i--) {
                    lastNonWhitespace = i
                    if (lineWithoutCommment[i] !== " ") {
                        endsInDot = lineWithoutCommment[i] === "."
                        break
                    }
                }

                let relativeCompletionPosition = endsInDot ? lastNonWhitespace + 1 : lastNonWhitespace

                const completionPosition = position + relativeCompletionPosition;

                testCases.push({
                    fileName,
                    fileText,
                    lineText: line.substr(0, commentIndex),
                    isPython,
                    expectedSymbols,
                    unwantedSymbols,
                    position: completionPosition,
                    // TODO: we could be smarter about the word start and end position, but
                    //  this works for all cases we care about so far.
                    wordStartPos: completionPosition,
                    wordEndPos: completionPosition,
                })
            }

            position += line.length + 1/*new lines*/;
        }
    }

    return testCases;
}

const fileName = (isPython: boolean) => isPython ? "main.py" : "main.ts"

function runCompletionTestCaseAsync(testCase: CompletionTestCase) {
    return getOptionsAsync(testCase.fileText, testCase.isPython)
        .then(opts => {
            setOptionsOp(opts);
            ensureAPIInfoOp();
            const result = completionsOp(
                fileName(testCase.isPython),
                testCase.position,
                testCase.wordStartPos,
                testCase.wordEndPos,
                testCase.fileText
            );

            if (pxtc.service.IsOpErr(result)) {
                chai.assert(false, `Lang service crashed with:\n${result.errorMessage}`)
                return;
            }

            const symbolIndex = (sym: string) => result.entries.reduce((prevIdx, s, idx) => {
                if (prevIdx >= 0)
                    return prevIdx
                if ((testCase.isPython ? s.pyQName : s.qName) === sym)
                    return idx;
                return -1
            }, -1)
            const hasSymbol = (sym: string) => symbolIndex(sym) >= 0;

            let lastFoundIdx = -1;
            for (const sym of testCase.expectedSymbols) {
                let idx = symbolIndex(sym)
                const foundSymbol = idx >= 0
                chai.assert(foundSymbol, `Did not receive symbol '${sym}' for '${testCase.lineText}'; instead we got ${result.entries.length} other symbols${result.entries.length < 5 ? ": " + result.entries.map(e => e.qName).join(", ") : "."}`);
                chai.assert(!foundSymbol || idx > lastFoundIdx, `Found symbol '${sym}', but in the wrong order at index: ${idx}. Expected it after: ${lastFoundIdx >= 0 ? result.entries[lastFoundIdx].qName : ""}`)
                lastFoundIdx = idx;
            }
            for (const sym of testCase.unwantedSymbols) {
                chai.assert(!hasSymbol(sym), `Receive explicitly unwanted symbol '${sym}' for '${testCase.lineText}'`);
            }
        })
}

function getOptionsAsync(fileContent: string, isPython: boolean) {
    const packageFiles: pxt.Map<string> = {};
    packageFiles[fileName(isPython)] = fileContent;

    return util.getTestCompileOptsAsync(packageFiles, testPackage, true)
        .then(opts => {
            if (isPython)
                opts.target.preferredEditor = pxt.PYTHON_PROJECT_NAME
            return opts
        })
}

function ensureAPIInfoOp() {
    pxtc.service.performOperation("apiInfo", {});
}

function setOptionsOp(opts: pxtc.CompileOptions) {
    return pxtc.service.performOperation("setOptions", {
        options: opts
    });
}

function completionsOp(fileName: string, position: number, wordStartPos: number, wordEndPos: number, fileContent?: string): pxtc.service.OpError | pxtc.CompletionInfo {
    return pxtc.service.performOperation("getCompletions", {
        fileName,
        fileContent,
        position,
        wordStartPos,
        wordEndPos,
        runtime: pxt.appTarget.runtime
    }) as pxtc.service.OpError | pxtc.CompletionInfo;
}