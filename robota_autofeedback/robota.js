// file simple_extension/main.js

define([
    'base/js/namespace'
], function (
    Jupyter
) {
    function load_ipython_extension() {

        // Lines annotated with this prefix will be retrieved
        var robota_suffix = "!robota";

        /* Defines each validator which can be applied. Each value should correspond
        *  an object with keys name, operator, num_inputs, description, example and func.
        *
        * The function's first parameter is reserved for the line being validated.
        * Thereafter, any additional parameters may be specified. Each function must return a boolean with keys
        * is_valid (bool) and feedback (str). is_valid should indicated whether the lines validates and feedback should
        * be a helpful message to be displayed in validation fails.
        *
        * num_inputs should _EXCLUDE_ the first parameter in its count. So, if a validator only takes the line,
        * this should be 0.
        */
        let validators = [
            {
                name: "different",
                description: "Checks that the value of the line is different from something.",
                num_inputs: 1,
                operator: "!=",
                example: "!robota:!=:1",
                func: function (line, value) {
                    return {
                        is_valid: line !== value,
                        feedback: `We expected the line to be different from ${value}, why don't you try changing it?`
                    };
                }
            },
            {
                name: "any",
                description: "Check that the line is equal to one of a set of possibilities.",
                num_inputs: "any",
                operator: "any",
                example: "!robota:any:a = 1:a = 2:a = 3",
                func: function(line, ...values) {
                    return {
                        is_valid: values.some(v => v === line),
                        feedback: `The line should be one of ${values}, but it isn't, why not trying changing it?`
                    };
                }
            },
            {
                name: "is_conditional",
                description: "Checks that the line contains a conditional. That is, an if statement",
                num_inputs: 0,
                operator: "is_conditional",
                example: "!robota:is_conditional",
                func: function(line) {
                    return {
                        is_valid: line.startsWith("if") && line.endsWith(":"),
                        feedback: "The line should be a conditional, so should start with an 'if' and end with a colon" +
                            "(:)"
                    };
                }
            },
            {
                name: "is_for",
                description: "Checks that the line contains a for loop.",
                num_inputs: 0,
                operator: "is_for",
                example: "!robota:is_for",
                func: function(line) {
                    return {
                        is_valid: line.startsWith("for") && line.includes("in") && line.endsWith(":"),
                        feedback: "The line should introduce a for loop, so should follow a template of type" +
                            "'for val in some_list'"
                    };
                }
            }
        ];

        /**
         * Given a notebook object (obtained as Jupyter.notebook), returns a list of all the CodeCell objects contained
         * therein.
         * @param notebook {Notebook} - The Jupyter notebook object
         * @returns Array{CodeCell} - The list of code cells contained in the notebook
         */
        var get_all_code_cells = function (notebook) {

            let cells = notebook.get_cells();

            return cells.filter(c => c.class_config.classname === "CodeCell")
        };

        /**
         * Given a code cell, executes robota automated feedback. That is, it executes the appropriate
         * validation(s)/instruction(s) against each row annotated with robota_suffix. Then, feedback is
         * appended as python comments to each cell.
         * @param code_cell {CodeCell} - The code_cell object that should be validated.
         */
        var execute_cell_annotations = function (code_cell) {
            let feedback_separator = "\n\n# **Feedback**\n";
            let raw_content = code_cell.get_text();
            let content = raw_content.split(feedback_separator)[0]
            code_cell.set_text(content)
            let lines = content.split("\n");
            // Selecting those lines which contain the robota suffix
            let annotated_lines = lines.filter(l => l.includes(robota_suffix));
            if(annotated_lines.length > 0) {
                let all_validation_results = annotated_lines.map(l => validate_line(l))
                code_cell.set_text(content + feedback_separator);
                all_validation_results.forEach(
                    avr => avr.forEach(
                        vr => code_cell.set_text(code_cell.get_text() + "# " + vr.message + "\n")
                    )
                );
            }
        };

        /**
         * Given an annotated line, executes the specified robota annotation(s) against it.
         * @param annotated_line {string} - The annotated line
         * @returns Array{object} - An array containing one object per validator applied to the line. Each object
         * contains a key is_valid, of type boolean, which indicates if the line validated against that validator.
         * And a key message, of type string, which contains a human-friendly message concerning the result of the
         * validator on that line.
         */
        var validate_line = function (annotated_line) {
            let line_tokens = annotated_line.split(robota_suffix);
            let line_input = line_tokens[0].replace("#", "").trim();
            let robota_annotation = line_tokens.pop();
            let annotation_tokens = robota_annotation.split(":").filter(t => t !== "")
            let validators = parse_annotation_tokens(annotation_tokens);

            // Function which executes each validator's function with the appropriate parameters, stores the
            // resulting value and building a human_readable message.
            let executor = function (line, f, parameters, name) {
                line = line.trim();
                let validation_result = f(line, ...parameters);

                let is_valid = validation_result.is_valid;
                let validation_message = validation_result.feedback;

                let message = "";

                if(is_valid) {
                    message = `Line ${line} was valid with regards to ${name}`;
                } else {
                    message = `Look back at ${line}. ${validation_message}`;
                }

                return {
                    is_valid: is_valid,
                    message: message
                };
            };

            let validation_results = validators.map(v => executor(
                line_input,
                v["validator_function"],
                v["parameters"],
                v["name"]
            ));

            return validation_results;
        };

        /**
         * Given a list of annotation tokens (Eg: ["!=", "1"]) returns a list of objects
         * where each object contains the validator's name, its function and parameters for that specific execution.
         *
         * Eg: ["!=", 1]
         *
         * Produces
         *
         * {
         *     name: "different",
         *     parameters: [1],
         *     validator_function: _The function object associated to the validator_
         * }
         *
         * It disregards unknown validators or validators where the right number of inputs has not been provided
         * @param tokens Array{string} - The list of tokens
         * @returns Array{object[]} - The aforementioned list of objects.
         */
        var parse_annotation_tokens = function (tokens) {
            // Holds the generated objects. that will be applied to the annotated line
            let objects = [];
            // Holds the object corresponding to the current validator
            let validator = null;
            // Holds the parameters being applied to the validator
            let parameters = [];

            let next_token = null;

            do {

                next_token = tokens.shift();

                let next_validator = validators.find(v => v.operator === next_token);

                if (validator == null && next_validator == null) {

                    // First token is not a validator, can't do anything
                    console.log("Invalid start character!");
                    return objects;

                } else if (next_validator != null && validator == null) {

                    // First character is a validator, assign it
                    validator = next_validator;

                } else if ((next_validator != null || next_token == null) && validator != null) {

                    // We have a validator but found another one. Or, we
                    // have a validator and this is the last token. Create function from current and
                    // get ready to process next.
                    if (validator["num_inputs"] != "any" && parameters.length != validator["num_inputs"]) {
                        console.log(`${validator.operator} expects ${validator.num_inputs} inputs,` +
                            `but ${parameters.length} were found. Skipping.`);
                        continue
                    }

                    let generated_object = {
                        validator_function: validator["func"],
                        parameters: parameters,
                        name: validator["name"]
                    };

                    objects.push(generated_object);

                    validator = next_validator;
                    next_validator = null;
                    parameters = [];


                } else if (next_validator == null && validator != null) {

                    // We have a validator but haven't found a new one, so we must have a parameter.
                    parameters.push(next_token);

                }

            } while (next_token != null || validator != null);

            return objects;
        };

        var handler = function () {
            console.log("robota here");
            code_cells = get_all_code_cells(Jupyter.notebook);
            code_cells.forEach(c => execute_cell_annotations(c))
        };

        var action = {
            icon: 'fa-check-circle-o',
            help: 'Run RoboTA Feedback',
            help_index: 'rta',
            handler: handler
        };
        var prefix = 'robota_autofeedback';
        var action_name = 'run-robota';

        var full_action_name = Jupyter.actions.register(action, action_name, prefix);
        Jupyter.toolbar.add_buttons_group([full_action_name]);
    }

    return {
        load_ipython_extension: load_ipython_extension
    };
});
