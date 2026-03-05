import * as core from "@actions/core";
import * as childProcess from 'child_process';
import * as fs from 'fs';

try {
    // Check to make sure the requested Servoy version exists in our GitHub Container Registry
    const servoyVersion = core.getInput("servoy-version"),
        testTimeout = parseInt(core.getInput("timeout"), 10);
    
        if (isNaN(testTimeout) || testTimeout < 0) {
            core.setFailed(`Invalid test timeout ${testTimeout}. Must be a positive integer.`);
            process.exit();
        }

        verifyServoyImage(servoyVersion);

        // Build our command before we pull the Docker image, so the user doesn't have to wait until the download completes
        // before they know something trivial is wrong.
        let commandArguments = buildDockerRunCommand();

        // Pull down the docker image
        downloadServoyImage(servoyVersion);

        const errorEscapeQuotes = core.getInput("errors-no-escape-quotes").toString() === "false",
            errorLineDelimiter = core.getInput("errors-line-delimiter"),
            warningEscapeQuotes = core.getInput("warnings-no-escape-quotes").toString() === "false",
            warningLineDelimiter = core.getInput("warnings-line-delimiter"),
            errorsFile = core.getInput("errors-file"),
            warningsFile = core.getInput("warnings-file");

        // Our command is now ready. Let 'er rip.
        runDockerCommand(commandArguments).then((info) => {
            let buildOutput = info[0];
            if (![null, undefined].includes(buildOutput)) {
                let { warningLines } = extractErrorWarningLines(buildOutput);
                if (warningLines.length > 0) {
                    let warningLinesString = warningLines.join(warningLineDelimiter);
                    if (warningEscapeQuotes) {
                        warningLinesString = warningLinesString.replace(/\"/g, '\\"');
                    }
                    fs.appendFileSync(process.env.GITHUB_OUTPUT, `WARNING_OUTPUT=${warningLinesString}\n`);
                    if (![null, undefined].includes(warningsFile) && warningsFile.trim() !== "") {
                        fs.writeFileSync(warningsFile, warningLinesString);
                    }
                }
            }
        }).catch((info) => {
            let buildOutput = info[0],
                failMessage = info[1];
            if (![null, undefined].includes(buildOutput)) {
                let { errorLines, warningLines } = extractErrorWarningLines(buildOutput);
                if (errorLines.length > 0) {
                    let errorLinesString = errorLines.join(errorLineDelimiter);
                    if (errorEscapeQuotes) {
                        errorLinesString = errorLinesString.replace(/\"/g, '\\"');
                    }
                    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ERROR_OUTPUT=${errorLinesString}\n`);
                    if (![null, undefined].includes(errorsFile) && errorsFile.trim() !== "") {
                        fs.writeFileSync(errorsFile, errorLinesString);
                    }
                }
                if (warningLines.length > 0) {
                    let warningLinesString = warningLines.join(warningLineDelimiter);
                    if (warningEscapeQuotes) {
                        warningLinesString = warningLinesString.replace(/\"/g, '\\"');
                    }
                    fs.appendFileSync(process.env.GITHUB_OUTPUT, `WARNING_OUTPUT=${warningLinesString}\n`);
                    if (![null, undefined].includes(warningsFile) && warningsFile.trim() !== "") {
                        fs.writeFileSync(warningsFile, warningLinesString);
                    }
                }
            }
            core.setFailed(failMessage);
            process.exit();
        })
} catch (e) {
    core.setFailed(e.message);
}

function buildDockerRunCommand() {
    // Required properties
    const servoyVersion = core.getInput("servoy-version"),
        solutionName = core.getInput("solution-name"),
        propertiesFile = core.getInput("properties-file"),
        buildMaxMemory = core.getInput("build-max-memory"),
        testResultsDir = core.getInput("test-results-dir"),
        testTimeout = core.getInput("timeout");

    let commandArguments = [
        "run", "--rm",
        "-v", `${process.env.GITHUB_WORKSPACE}:/servoy_code`,
        "-v", `${process.env.GITHUB_WORKSPACE}/${propertiesFile}:/usr/home/servoy/application_server/servoy.properties`,
        "-v", `${process.env.GITHUB_WORKSPACE}/${testResultsDir}:/tmp/test_results`,
        "-e", `ANT_OPTS="-Xms${buildMaxMemory} -Xmx${buildMaxMemory}`
    ], extrasFolder = core.getInput("extras-folder");
    if (extrasFolder !== "") {
        let extrasFolderFullPath = `${process.env.GITHUB_WORKSPACE}/${extrasFolder}`;

        // Make sure the extras folder exists, and contains an application_server folder.
        if (!fs.existsSync(extrasFolderFullPath)) {
            core.setFailed(`Extras folder ${extrasFolder} does not exist.`);
            process.exit();
        } else if (!fs.existsSync(`${extrasFolderFullPath}/application_server`)) {
            core.setFailed(`Invalid extras folder. Should contain a sub-directory named "application_server".`);
            process.exit();
        } else {
            commandArguments = commandArguments.concat(["-v", `${extrasFolderFullPath}:/servoy_extras`]);
        }
    }

    commandArguments = commandArguments.concat([
        `ghcr.io/servoycomponents/servoy_tester:${servoyVersion}`,
        `-Dsmart_test_solutions="${solutionName}"`,
        `-Dtest.timeout="${testTimeout}"`
    ]);

    const servoyVersionParts = servoyVersion.split("."),
        servoyMajorVersion = parseInt(servoyVersionParts[0], 10),
        servoyMinorVersion = parseInt(servoyVersionParts[1], 10),
        isServoy73OrHigher = servoyMajorVersion > 7 || (servoyMajorVersion === 7 && servoyMinorVersion >= 3);
    if (isServoy73OrHigher) {
        commandArguments.push("-Dwork.servoy.install.7.3.or.higher=yep");
    }

    let stringFields = {
            "beans": "servoy.export.options.beans",
            "exclude-beans": "servoy.export.options.exclude_beans",
            "lafs": "servoy.export.options.lafs",
            "exclude-lafs": "servoy.export.options.exclude_lafs",
            "drivers": "servoy.export.options.drivers",
            "exclude-drivers": "servoy.export.options.exclude_drivers",
            "plugins": "servoy.export.options.plugins",
            "exclude-plugins": "servoy.export.options.exclude_plugins",
            "additional-solutions": "servoy.export.options.additional_solutions",
            "components": "servoy.export.options.components",
            "exclude-components": "servoy.export.options.exclude_components",
            "services": "servoy.export.options.services",
            "exclude-services": "servoy.export.options.exclude_services",
            "sample-data-row-count": "servoy.export.options.sample_data_row_count",
            "ng2": "servoy.export.options.ng2"
        },
        prependWorkspacePrefixFields = [
            "context-file-name",
            "log4j-configuration-name",
            "web-xml-file-name"
        ],
        booleanFields = {
            "ignore-build-errors": "servoy.export.flags.ignore_errors",
            "skip-build": "servoy.export.flags.skip_build",
            "dbi": "servoy.export.flags.dbi",
            "export-metadata": "servoy.export.flags.metadata",
            "check-metadata": "servoy.export.flags.check_metadata",
            "sample-data": "servoy.export.flags.sample_data",
            "i18n": "servoy.export.flags.i18n",
            "users": "servoy.export.flags.users",
            "tables": "servoy.export.flags.tables",
            "allow-sql-keywords": "servoy.export.flags.allow_sql_keywords",
            "ng1": "servoy.export.flags.ng1",
            "verbose": "servoy.export.flags.verbose"
        };
    Object.keys(stringFields).forEach((stringField) => {
        let stringFieldValue = core.getInput(stringField);
        if ([null, undefined].includes(stringFieldValue) || stringFieldValue.trim() === "") {
            return;
        }
        if (prependWorkspacePrefixFields.includes(stringField)) {
            stringFieldValue=`/servoy_code/${stringFieldValue}`;
        }
        commandArguments.push(`-D${stringFields[stringField]}="${stringFieldValue}"`);
    });
    Object.keys(booleanFields).forEach((booleanField) => {
        let booleanFieldValue = core.getBooleanInput(booleanField);
        if (!booleanFieldValue) {
            return;
        }

        commandArguments.push(`-D${booleanFields[booleanField]}=1`);
    });

    return commandArguments;
}

function verifyServoyImage(servoyVersion) {
    core.info(`Checking for existence of tester for Servoy version: ${servoyVersion}`);

    // Make sure the provided Servoy version number matches the version format (prevent command injection)
    let servoyVersionFormat = /^\d{1,4}\.\d{1,2}(\.\d+)?\.\d{4}$/;
    if (!servoyVersionFormat.test(servoyVersion) && ["nightly", "nightly-lts"].indexOf(servoyVersion) == -1) {
        core.setFailed(`Invalid Servoy version: ${servoyVersion}`);
        process.exit();
    }

    const inspectManifestProcess = childProcess.spawnSync(
        'docker',
        ['manifest', 'inspect', `ghcr.io/servoycomponents/servoy_tester:${servoyVersion}`],
        { encoding: 'utf-8' }
    );
    if (~[null, 1].indexOf(inspectManifestProcess.status)) {
        // Manifest inspect failed (we don't have that version), so let's output what the command output was and set the failure.
        core.info(`Docker return code: ${inspectManifestProcess.status}`);
        core.info(`Docker stdout: ${inspectManifestProcess.stdout}`);
        core.info(`Docker stderr: ${inspectManifestProcess.stderr}`);
        core.setFailed(`Servoy version not found: ${servoyVersion}`);
        process.exit();
    }
}

function downloadServoyImage(servoyVersion) {
    core.info(`Downloading tester for Servoy version: ${servoyVersion}`);
    const pullProcess = childProcess.spawnSync(
        'docker',
        ['pull', `ghcr.io/servoycomponents/servoy_tester:${servoyVersion}`],
        { stdio: 'inherit' }
    );
    if (pullProcess.status === null || pullProcess.status !== 0) {
        core.setFailed(`Download of tester failed for Servoy version: ${servoyVersion}`);
        process.exit();
    }
}

function runDockerCommand(commandArguments, buildTimeout) {
    return new Promise((res, rej) => {
        // Our command is now ready. Let 'er rip.
        let dockerRunOutput = "";
        console.log(`Docker command arguments:`);
        console.log(JSON.stringify(commandArguments));
        
        const dockerRunProcess = childProcess.spawn("docker", commandArguments, {timeout: buildTimeout});
        dockerRunProcess.stdout.setEncoding("utf-8");
        dockerRunProcess.stdout.on("data", (data) => {
            if (~[null, undefined, ""].indexOf(data)) return;

            dockerRunOutput += data.toString();
            process.stdout.write(data);
        });
        dockerRunProcess.stderr.setEncoding("utf-8");
        dockerRunProcess.stderr.on("data", (data) => {
            if ([null, undefined, ""].includes(data)) return;

            process.stderr.write(data);
        });
        dockerRunProcess.on("close", (code) => {
            if (!~[null, undefined].indexOf(dockerRunProcess.error) && ~dockerRunProcess.error.message.indexOf("ETIMEDOUT")) {
                rej([null, "Test timeout exceeded."]);
            } else if (code !== 0) {
                core.setOutput(`Docker result code: ${code}`);
                rej([dockerRunOutput, "Tests failed. Please check the logs for more details."]);
            } else {
                res([dockerRunOutput]);
            }
        });
    });
}

function extractErrorWarningLines(buildOutput) {
    let outputLines = buildOutput.split("\n").map((val) => val.trim()),
        errorLines = [],
        warningLines = [],
        capturingErrors = false,
        capturingWarnings = false;
    for (let i = 0; i < outputLines.length; i++) {
        let outputLine = outputLines[i].trim();
        if (outputLine.startsWith("[java] ")) {
            outputLine = outputLine.substring(7).trim();
        } else if (outputLine.startsWith("[junit] ")) {
            outputLine = outputLine.substring(8).trim();
        }
        if (outputLine.includes("Standard Error")) {
            capturingWarnings = false;
            capturingErrors = true;
        } else if (outputLine.startsWith("Found warning markers in projects for solution")) {
            capturingErrors = false;
            capturingWarnings = true;
        } else if (capturingErrors && outputLine.trim() !== "") {
            errorLines.push(outputLine);
        } else if (capturingErrors && outputLine.trim() === "") {
            capturingErrors = false;
        } else if (capturingWarnings && outputLine.startsWith("-") && !outputLine.startsWith("--")) {
            warningLines.push(outputLine);
        }
    }
    return {
        errorLines,
        warningLines
    };
}