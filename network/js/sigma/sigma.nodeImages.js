(function () {
    "use strict";

    var MIN_IMAGE_RADIUS = 3;      // Minimum screen radius (px) to render a photo instead of a flat dot
    var MAX_CONCURRENT_LOADS = 10; // Bounded parallel image requests to external CDN

    var imageCache = {}; // url -> { img: HTMLImageElement|null, status: "queued"|"loading"|"loaded"|"error" }
    var loadQueue = [];
    var activeLoads = 0;

    function getNodeImageUrl(node) {
        if (!node || !node.attr) return null;
        if (node.attr.image) return node.attr.image;
        if (node.attr.attributes && node.attr.attributes.image) {
            return node.attr.attributes.image;
        }
        return null;
    }

    function attachNodeImagePlugin(core) {
        var plotter = core.plotter;
        var graph = core.graph;
        var nodeDom = core.domElements.nodes;
        var nodeCtx = nodeDom.getContext("2d");
        var hoverCtx = core.domElements.hover.getContext("2d");
        var redrawTimer = null;

        function scheduleNodeLayerRedraw() {
            if (redrawTimer !== null) return;
            redrawTimer = window.setTimeout(function () {
                redrawTimer = null;
                if (!core.p || !core.p.lastNodes) return;
                nodeCtx.clearRect(0, 0, nodeDom.width, nodeDom.height);
                plotter.currentNodeIndex = 0;
                while (plotter.task_drawNode()) {}
                core.refresh();
            }, 120);
        }

        function pumpQueue() {
            while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
                var url = loadQueue.shift();
                var entry = imageCache[url];
                if (!entry || entry.status !== "queued") continue;

                entry.status = "loading";
                activeLoads++;

                (function (targetUrl, cacheEntry) {
                    var img = new Image();
                    cacheEntry.img = img;

                    img.onload = function () {
                        activeLoads--;
                        cacheEntry.status = "loaded";
                        scheduleNodeLayerRedraw();
                        pumpQueue();
                    };

                    img.onerror = function () {
                        activeLoads--;
                        cacheEntry.status = "error";
                        pumpQueue();
                    };

                    img.src = targetUrl;
                })(url, entry);
            }
        }

        function requestImage(url) {
            if (!url) return null;
            var entry = imageCache[url];
            if (entry) {
                return entry.status === "loaded" ? entry.img : null;
            }
            imageCache[url] = { img: null, status: "queued" };
            loadQueue.push(url);
            pumpQueue();
            return null;
        }

        function drawCircularImageOrFallback(
            ctx,
            node,
            x,
            y,
            r,
            fallbackColor,
            borderColor,
            borderWidth
        ) {
            var isDimmed = !!(node.attr && node.attr.grey);
            var url = getNodeImageUrl(node);
            var img = r >= MIN_IMAGE_RADIUS ? requestImage(url) : null;

            ctx.save();
            if (isDimmed) {
                ctx.globalAlpha = 0.2;
            }

            if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
                ctx.beginPath();
                ctx.arc(x, y, r, 0, 2 * Math.PI, true);
                ctx.closePath();
                ctx.save();
                ctx.clip();

                var iw = img.naturalWidth;
                var ih = img.naturalHeight;
                var scale = Math.max((2 * r) / iw, (2 * r) / ih);
                var dw = iw * scale;
                var dh = ih * scale;
                ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
                ctx.restore();

                ctx.beginPath();
                ctx.arc(x, y, r, 0, 2 * Math.PI, true);
                if (borderWidth > 0) {
                    ctx.strokeStyle = borderColor;
                    ctx.lineWidth = borderWidth;
                } else {
                    ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
                    ctx.lineWidth = Math.max(0.6, Math.min(1.5, r * 0.08));
                }
                ctx.stroke();
            } else {
                ctx.fillStyle = fallbackColor;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, 2 * Math.PI, true);
                ctx.closePath();
                ctx.fill();

                if (borderWidth > 0) {
                    ctx.strokeStyle = borderColor;
                    ctx.lineWidth = borderWidth;
                    ctx.stroke();
                }
            }

            ctx.restore();
        }

        plotter.task_drawNode = function () {
            var nodes = graph.nodes;
            var len = nodes.length;
            var count = 0;

            while (count++ < plotter.p.nodesSpeed && plotter.currentNodeIndex < len) {
                var node = nodes[plotter.currentNodeIndex++];
                if (!plotter.isOnScreen(node)) continue;

                var r = Math.max(1, Math.round(10 * node.displaySize) / 10);
                var color = node.color || plotter.p.defaultNodeColor;
                var lineWidth = node.attr && node.attr.lineWidth ? node.attr.lineWidth : 0;
                var strokeStyle = (node.attr && node.attr.strokeStyle) || "#000";

                drawCircularImageOrFallback(
                    nodeCtx,
                    node,
                    node.displayX,
                    node.displayY,
                    r,
                    color,
                    strokeStyle,
                    lineWidth
                );

                if (node.hover) {
                    plotter.drawHoverNode(node);
                }
            }

            return plotter.currentNodeIndex < len;
        };

        plotter.drawHoverNode = function (node) {
            if (!plotter.isOnScreen(node)) return plotter;

            var labelSize =
                plotter.p.labelSize === "fixed"
                    ? plotter.p.defaultLabelSize
                    : plotter.p.labelSizeRatio * node.displaySize;

            hoverCtx.font =
                (plotter.p.hoverFontStyle || plotter.p.fontStyle || "") +
                " " +
                labelSize +
                "px " +
                (plotter.p.hoverFont || plotter.p.font || "");

            hoverCtx.fillStyle =
                plotter.p.labelHoverBGColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultHoverLabelBGColor;

            hoverCtx.beginPath();
            if (plotter.p.labelHoverShadow) {
                hoverCtx.shadowOffsetX = 0;
                hoverCtx.shadowOffsetY = 0;
                hoverCtx.shadowBlur = 4;
                hoverCtx.shadowColor = plotter.p.labelHoverShadowColor;
            }
            sigma.tools.drawRoundRect(
                hoverCtx,
                Math.round(node.displayX - labelSize / 2 - 2),
                Math.round(node.displayY - labelSize / 2 - 2),
                Math.round(
                    hoverCtx.measureText(node.label).width +
                        1.5 * node.displaySize +
                        labelSize / 2 +
                        4
                ),
                Math.round(labelSize + 4),
                Math.round(labelSize / 2 + 2),
                "left"
            );
            hoverCtx.closePath();
            hoverCtx.fill();

            hoverCtx.shadowOffsetX = 0;
            hoverCtx.shadowOffsetY = 0;
            hoverCtx.shadowBlur = 0;

            var r = Math.max(1, node.displaySize);
            var borderColor =
                plotter.p.nodeBorderColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultNodeBorderColor;
            var hoverColor =
                plotter.p.nodeHoverColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultNodeHoverColor;

            drawCircularImageOrFallback(
                hoverCtx,
                node,
                Math.round(node.displayX),
                Math.round(node.displayY),
                r,
                hoverColor,
                borderColor,
                Math.max(1.5, plotter.p.borderSize || 1.5)
            );

            hoverCtx.fillStyle =
                plotter.p.labelHoverColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultLabelHoverColor;
            hoverCtx.fillText(
                node.label,
                Math.round(node.displayX + 1.5 * node.displaySize),
                Math.round(node.displayY + labelSize / 2 - 3)
            );

            return plotter;
        };

        plotter.drawActiveNode = function (node) {
            if (!plotter.isOnScreen(node)) return plotter;

            var labelSize =
                plotter.p.labelSize === "fixed"
                    ? plotter.p.defaultLabelSize
                    : plotter.p.labelSizeRatio * node.displaySize;

            hoverCtx.font =
                (plotter.p.activeFontStyle || plotter.p.fontStyle || "") +
                " " +
                labelSize +
                "px " +
                (plotter.p.activeFont || plotter.p.font || "");

            hoverCtx.fillStyle =
                plotter.p.labelActiveBGColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultActiveLabelBGColor;

            hoverCtx.beginPath();
            if (plotter.p.labelActiveShadow) {
                hoverCtx.shadowOffsetX = 0;
                hoverCtx.shadowOffsetY = 0;
                hoverCtx.shadowBlur = 4;
                hoverCtx.shadowColor = plotter.p.labelActiveShadowColor;
            }
            sigma.tools.drawRoundRect(
                hoverCtx,
                Math.round(node.displayX - labelSize / 2 - 2),
                Math.round(node.displayY - labelSize / 2 - 2),
                Math.round(
                    hoverCtx.measureText(node.label).width +
                        1.5 * node.displaySize +
                        labelSize / 2 +
                        4
                ),
                Math.round(labelSize + 4),
                Math.round(labelSize / 2 + 2),
                "left"
            );
            hoverCtx.closePath();
            hoverCtx.fill();

            hoverCtx.shadowOffsetX = 0;
            hoverCtx.shadowOffsetY = 0;
            hoverCtx.shadowBlur = 0;

            var r = Math.max(1, node.displaySize);
            var borderColor =
                plotter.p.nodeBorderColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultNodeBorderColor;
            var activeColor =
                plotter.p.nodeActiveColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultNodeActiveColor;

            drawCircularImageOrFallback(
                hoverCtx,
                node,
                Math.round(node.displayX),
                Math.round(node.displayY),
                r,
                activeColor,
                borderColor,
                Math.max(2, plotter.p.borderSize || 2)
            );

            hoverCtx.fillStyle =
                plotter.p.labelActiveColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultLabelActiveColor;
            hoverCtx.fillText(
                node.label,
                Math.round(node.displayX + 1.5 * node.displaySize),
                Math.round(node.displayY + labelSize / 2 - 3)
            );

            return plotter;
        };
    }

    sigma.addPlugin(
        "nodeImages",
        function () {
            return this;
        },
        attachNodeImagePlugin
    );
})();
