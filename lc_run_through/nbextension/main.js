define([
    'jquery',
    'require',
    'base/js/namespace',
    'base/js/events',
    'services/config',
    'notebook/js/textcell',
    'notebook/js/codecell',
    'nbextensions/collapsible_headings/main',
    'nbextensions/freeze/main'
], function($, require, Jupyter, events, configmod, textcell, codecell, ch,
            freeze) {
    'use strict';

    var cells_status = {};
    var result_views = {};
    var execute_status = Array();

    function init_events() {
        events.on('create.Cell', function (e, data) {
            cell_appended(data.cell);
        });

        events.on('delete.Cell', function (e, data) {
            cell_deleted(data.cell);
        });
    }

    function patch_CodeCell_get_callbacks() {
        console.log('[run_through] patching CodeCell.prototype.get_callbacks');
        var previous_get_callbacks = codecell.CodeCell.prototype.get_callbacks;
        codecell.CodeCell.prototype.get_callbacks = function() {
            var that = this;
            var callbacks = previous_get_callbacks.apply(this, arguments);
            var prev_reply_callback = callbacks.shell.reply;
            callbacks.shell.reply = function(msg) {
                if (msg.msg_type === 'execute_reply') {
                    console.log('[run_through] execute_reply');
                    setTimeout(function() {
                        finished_execute(that, msg.content.status);
                    }, 100);
                }
                return prev_reply_callback(msg);
            };
            return callbacks;
        };
    }

    function patch_CodeCell_clear_output() {
        console.log('[run_through] patching CodeCell.prototype.clear_output');
        var previous_clear_output = codecell.CodeCell.prototype.clear_output;
        codecell.CodeCell.prototype.clear_output = function() {
            previous_clear_output.apply(this, arguments);
            var cell = this;
            var results = result_views[cell.cell_id];
            if (results) {
                $.each(results, function(i, result) {
                    var status = get_output_status(cell);
                    var frozen = is_frozen(cell);
                    update_result_elem(result.element, status, frozen);
                });
            }
        }
    }

    function init_cell_states() {
        var cells = Jupyter.notebook.get_cells();
        for (var i=0; i<cells.length; ++i) {
            cell_appended(cells[i]);
        }
    }

    function is_heading(cell) {
        return ch.get_cell_level(cell) < 7;
    }

    function is_collapsed(cell) {
        return cell.metadata.heading_collapsed === true;
    }

    function cell_appended(cell) {
        if (!(cell instanceof textcell.MarkdownCell)) {
            return;
        }

        var cell_mo = new MutationObserver(function(mutationRecords){
            for (var i=0; i<mutationRecords.length; ++i) {
                var mr = mutationRecords[i];
                var status = cells_status[cell.cell_id]
                if (status.collapsed !== (cell.metadata.heading_collapsed === true)) {
                    status.collapsed = cell.metadata.heading_collapsed === true;
                    if (status.collapsed) {
                        heading_collapsed(cell);
                    } else if (typeof(status.collapsed) !== 'undefined'){
                        heading_expanded(cell);
                    }
                }
            }
        });

        cell_mo.observe(cell.element.get(0),
                   {attributes: true,
                    attributeOldValue: true,
                    attributeFilter: [ 'class' ]
                   });

        var cell_status = {
            collapsed: undefined,
            cell: cell,
            cell_mo: cell_mo,
            section_cells: [],
        }
        cells_status[cell.cell_id] = cell_status;
    }

    function cell_deleted(cell) {
        if (!(cell instanceof textcell.MarkdownCell)) {
            return;
        }

        var status = cells_status[cell.cell_id];
        status.cell_mo.disconnect();
        delete cells_status[cell.cell_id];
    }

    function heading_collapsed(cell) {
        create_execute_ui(cell);
    }

    function heading_expanded(cell) {
        remove_execute_ui(cell);
    }

    function create_execute_ui(cell) {
        var container = $('<div/>')
                    .addClass('run-through')
                    .appendTo(cell.element.find('.inner_cell'));

        var btn = $('<div/>')
                    .append('<button class="btn btn-default"/>')
                    .appendTo(container);

        var clickable = btn.find('button');
        $('<i class="fa fa-fw fa-play-circle"/>').appendTo(clickable);
        clickable.on('click', function (e) {
           execute_section(cell);
        });

        var section_cells = get_section_cells(cell);
        create_result_view(container, cell, section_cells);
        cells_status[cell.cell_id]['section_cells'] = section_cells;
    }

    function remove_execute_ui(cell) {
        cell.element.find('.run-through').remove();
        var section_cells = cells_status[cell.cell_id]['section_cells'];
        remove_result_view(cell, section_cells);
        delete cells_status[cell.cell_id]['section_cells'];
    }

    function create_result_view(container, heading_cell, section_cells) {
        for(var i=0; i<section_cells.length; ++i) {
            var cell = section_cells[i];
            var elem;
            if (cell instanceof codecell.CodeCell) {
                elem = $('<span/>').addClass('code-result');
                elem.appendTo(container);
            } else if (is_heading(cell)) {
                elem = $('<span/>').addClass('heading-result');
                elem.text(get_heading_text(cell));
                elem.appendTo(container);
            } else {
                elem = $('<span/>').addClass('text-result');
                elem.appendTo(container);
            }
            var result = {
                element: elem,
                cell: cell,
                heading_cell: heading_cell
            };
            if (result_views[cell.cell_id] === undefined) {
                result_views[cell.cell_id] = [];
            }
            result_views[cell.cell_id].push(result);
            if (cell instanceof codecell.CodeCell) {
                update_result_elem(elem, get_output_status(cell), is_frozen(cell));
            }
        }
    }

    function remove_result_view(heading_cell, section_cells) {
        for(var i=0; i<section_cells.length; ++i) {
            var cell = section_cells[i];
            var views = result_views[cell.cell_id];
            if (!views) {
                continue;
            }
            var removed_cell_views = $.grep(views, function(item) {
                return item.heading_cell === heading_cell;
            });
            $.each(removed_cell_views, function(i, removed_item) {
                views.splice( $.inArray(removed_item, views), 1 );
            });
            if (result_views[cell.cell_id].length === 0) {
                delete result_views[cell.cell_id];
            }
        }
    }

    function update_all_result_view() {
        $.each(result_views, function(cell_id, results) {
            $.each(results, function(i, result) {
                var status = get_output_status(result.cell);
                var frozen = is_frozen(result.cell);
                update_result_elem(result.element, status, frozen);
            });
        });
    }

    function update_result_elem(result_elem, status, frozen) {
        result_elem.removeClass('code-success code-error');
        if (status == "error") {
            result_elem.addClass('code-error');
        } else if (status == "ok") {
            result_elem.addClass('code-success');
        }
        if (frozen) {
            result_elem.addClass('fa fa-lock')
        } else {
            result_elem.removeClass('fa fa-lock')
        }
    }

    function execute_section(heading_cell) {
        console.log('[run_through] start to execute the section: %s', get_heading_text(heading_cell));
        var section_cells = get_section_cells(heading_cell);
        for (var i=0; i<section_cells.length; ++i) {
            var cell = section_cells[i];
            if (cell instanceof codecell.CodeCell) {
                cell.execute();
            }
        }
        setTimeout(function() {
            update_all_result_view();
        }, 100);
    }

    function get_heading_text(heading_cell)
    {
        if(!is_heading(heading_cell)) {
            return "";
        }

        var elem = 'h' + ch.get_cell_level(heading_cell);
        return heading_cell.element.find('.rendered_html ' + elem)
            .contents()
            .filter(function() {
                return this.nodeType === 3 && $.inArray($(this).parent(), heading_cell);
            }).text();
    }

    function get_section_cells(heading_cell)
    {
        var top_level = ch.get_cell_level(heading_cell);
        var cells = Jupyter.notebook.get_cells();

        var index = Jupyter.notebook.find_cell_index(heading_cell);
        var section_cells = new Array();
        for (var i=index+1; i<cells.length; ++i) {
            var cell = cells[i];
            var level = ch.get_cell_level(cell);
            if (level > top_level) {
                section_cells.push(cell);
            } else if(level <= top_level) {
                break;
            }
        }
        return section_cells;
    }

    function finished_execute(cell, status) {
        var index = Jupyter.notebook.find_cell_index(cell);
        console.log("[run_through] cell execution finished: index=%s, status=%s", index, status);
        if (status == "ok") {
            console.log('[run_through] freeze executed cell: %d', index);
            freeze_cell(cell);
        }
        var results = result_views[cell.cell_id];
        if (results) {
            var frozen = is_frozen(cell);
            $.each(results, function(i, result) {
                update_result_elem(result.element, status, frozen);
            });
        }
    }

    function get_output_status(cell) {
        if (!(cell instanceof codecell.CodeCell)) {
            return null;
        }
        if (!cell.input_prompt_number || cell.input_prompt_number === "*") {
            return null;
        }
        var outputs = cell.output_area.outputs;
        for (var i=0; i<outputs.length; ++i) {
            if(outputs[i].output_type === "error") {
                return "error";
            }
        }
        return "ok";
    }

    function is_frozen(cell) {
        return freeze.get_state(cell) == 'frozen';
    }

    function freeze_cell(cell) {
        if (!(cell instanceof codecell.CodeCell)) {
            return;
        }
        freeze.set_state(cell, 'frozen');
    }

    function unfreeze_cell(cell) {
        if (!(cell instanceof codecell.CodeCell)) {
            return;
        }
        freeze.set_state(cell, 'normal');

        var results = result_views[cell.cell_id];
        if (results) {
            $.each(results, function(i, result) {
                var status = get_output_status(result.cell);
                var frozen = is_frozen(result.cell);
                update_result_elem(result.element, status, frozen);
            });
        }
    }

    function unfreeze_below_in_section() {
        var index = Jupyter.notebook.get_selected_index();
        var cells = Jupyter.notebook.get_cells();

        var heading_cell = find_heading_cell(cells[index]);
        var section;
        if (heading_cell) {
            section = get_section_cells(heading_cell);
            section.splice(0, 0, heading_cell);
        } else {
            section = [];
            var heading_index = Jupyter.notebook.find_cell_index(heading_cell);
            var level = ch.get_cell_level(cells[index]);
            for (var i=heading_index; i<cells.length; ++i) {
                if (ch.get_cell_level(cells[i]) !== level) {
                    break;
                }
                section.push(cells[i]);
            }
        }

        var index_in_section = $.inArray(cells[index], section);
        for (var i=index_in_section; i<section.length; ++i) {
            unfreeze_cell(section[i]);
        }
    }

    function find_heading_cell(cell) {
        if (is_heading(cell)) {
            return cell;
        }

        var cells = cell.notebook.get_cells();
        var index = cell.notebook.find_cell_index(cell);
        if (index == 0) {
            return null;
        }
        for (var i=index-1; i>=0; --i) {
            if (is_heading(cells[i])) {
                return cells[i];
            }
        }
        return null;
    }

    function unfreeze_below_all() {
        var index = Jupyter.notebook.get_selected_index();
        var cells = Jupyter.notebook.get_cells();
        for (var i=index; i<cells.length; ++i) {
           unfreeze_cell(cells[i]);
        }
    }

    function regist_toolbar_buttons() {
        Jupyter.toolbar.add_buttons_group([
            {
                id : 'unfreeze_below_in_section',
                label : 'unfreeze below in section',
                icon: 'fa-unlock-below-in-section',
                callback : unfreeze_below_in_section
            },
            {
                id : 'unfreeze_below_all',
                label : 'unfreeze below all',
                icon: 'fa-unlock-below-all',
                callback : unfreeze_below_all
            }
        ]);
    }

    function load_extension() {
        $('<link/>')
            .attr({
                id: 'run_thorugh_css',
                rel: 'stylesheet',
                type: 'text/css',
                href: require.toUrl('./main.css')
            })
            .appendTo('head');

        var extensions = Jupyter.notebook.config.data.load_extensions;
        if (!extensions['freeze/main']) {
            console.error('[run_through] Please enables freeze extension');
        }
        if (!extensions['collapsible_headings/main']) {
            console.error('[run_through] Please enables collapsible_headings extension');
        }

        init_events();
        regist_toolbar_buttons();
        patch_CodeCell_get_callbacks();
        patch_CodeCell_clear_output();

        events.on("notebook_loaded.Notebook", init_cell_states);
        if (Jupyter.notebook !== undefined && Jupyter.notebook._fully_loaded) {
            init_cell_states();
        }
    }

    return {
        update_all_result_view: update_all_result_view,
        load_ipython_extension: load_extension,
        load_jupyter_extension: load_extension
    };
});
