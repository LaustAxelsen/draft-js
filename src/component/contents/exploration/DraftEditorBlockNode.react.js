/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DraftEditorBlockNode.react
 * @format
 * @flow
 *
 * This file is a fork of DraftEditorBlock.react.js and DraftEditorContents.react.js
 *
 * This is unstable and not part of the public API and should not be used by
 * production systems. This file may be update/removed without notice.
 */

'use strict';

import type {BlockNodeRecord} from 'BlockNodeRecord';
import type ContentState from 'ContentState';
import type {DraftBlockRenderMap} from 'DraftBlockRenderMap';
import type {DraftDecoratorType} from 'DraftDecoratorType';
import type {DraftInlineStyle} from 'DraftInlineStyle';
import type SelectionState from 'SelectionState';
import type {BidiDirection} from 'UnicodeBidiDirection';

const DraftEditorNode = require('DraftEditorNode.react');
const DraftOffsetKey = require('DraftOffsetKey');
const EditorState = require('EditorState');
const Immutable = require('immutable');
const React = require('React');
const ReactDOM = require('ReactDOM');
const Scroll = require('Scroll');
const Style = require('Style');

const getElementPosition = require('getElementPosition');
const getScrollPosition = require('getScrollPosition');
const getViewportDimensions = require('getViewportDimensions');
const invariant = require('invariant');

const SCROLL_BUFFER = 10;

const {List} = Immutable;

// we should harden up the bellow flow types to make them more strict
type CustomRenderConfig = Object;
type DraftRenderConfig = Object;
type BlockRenderFn = (block: BlockNodeRecord) => ?Object;
type BlockStyleFn = (block: BlockNodeRecord) => string;

type Props = {
  block: BlockNodeRecord,
  blockProps?: Object,
  blockRenderMap: DraftBlockRenderMap,
  blockRendererFn: BlockRenderFn,
  blockStyleFn: BlockStyleFn,
  contentState: ContentState,
  customStyleFn: (style: DraftInlineStyle, block: BlockNodeRecord) => ?Object,
  customStyleMap: Object,
  decorator: ?DraftDecoratorType,
  direction: BidiDirection,
  editorKey: string,
  editorState: EditorState,
  forceSelection: boolean,
  selection: SelectionState,
  startIndent?: boolean,
  tree: List<any>,
};

/**
 * Return whether a block overlaps with either edge of the `SelectionState`.
 */
const isBlockOnSelectionEdge = (
  selection: SelectionState,
  key: string,
): boolean => {
  return selection.getAnchorKey() === key || selection.getFocusKey() === key;
};

/**
 * We will use this helper to identify blocks that need to be wrapped but have siblings that
 * also share the same wrapper element, this way we can do the wrapping once the last sibling
 * is added.
 */
const shouldNotAddWrapperElement = (
  block: BlockNodeRecord,
  contentState: ContentState,
): boolean => {
  const nextSiblingKey = block.getNextSiblingKey();

  return nextSiblingKey
    ? contentState.getBlockForKey(nextSiblingKey).getType() === block.getType()
    : false;
};

const applyWrapperElementToSiblings = (
  wrapperTemplate: *,
  Element: string,
  nodes: Array<React.Node>,
): Array<React.Node> => {
  const wrappedSiblings = [];

  // we check back until we find a sibbling that does not have same wrapper
  for (const sibling: any of nodes.reverse()) {
    if (sibling.type !== Element) {
      break;
    }
    wrappedSiblings.push(sibling);
  }

  // we now should remove from acc the wrappedSiblings and add them back under same wrap
  nodes.splice(nodes.indexOf(wrappedSiblings[0]), wrappedSiblings.length + 1);

  const childrenIs = wrappedSiblings.reverse();

  const key = childrenIs[0].key;

  nodes.push(
    React.cloneElement(
      wrapperTemplate,
      {
        key: `${key}-wrap`,
        'data-offset-key': DraftOffsetKey.encode(key, 0, 0),
      },
      childrenIs,
    ),
  );

  return nodes;
};

const getDraftRenderConfig = (
  block: BlockNodeRecord,
  blockRenderMap: DraftBlockRenderMap,
): DraftRenderConfig => {
  const configForType =
    blockRenderMap.get(block.getType()) || blockRenderMap.get('unstyled');

  const wrapperTemplate = configForType.wrapper;
  const Element =
    configForType.element || blockRenderMap.get('unstyled').element;

  return {
    Element,
    wrapperTemplate,
  };
};

const getCustomRenderConfig = (
  block: BlockNodeRecord,
  blockRendererFn: BlockRenderFn,
): CustomRenderConfig => {
  const customRenderer = blockRendererFn(block);

  if (!customRenderer) {
    return {};
  }

  const {
    component: CustomComponent,
    props: customProps,
    editable: customEditable,
  } = customRenderer;

  return {
    CustomComponent,
    customProps,
    customEditable,
  };
};

const getElementPropsConfig = (
  block: BlockNodeRecord,
  editorKey: string,
  offsetKey: string,
  blockStyleFn: BlockStyleFn,
  customConfig: *,
): Object => {
  let elementProps: Object = {
    'data-block': true,
    'data-editor': editorKey,
    'data-offset-key': offsetKey,
    key: block.getKey(),
  };
  const customClass = blockStyleFn(block);

  if (customClass) {
    elementProps.className = customClass;
  }

  if (customConfig.customEditable !== undefined) {
    elementProps = {
      ...elementProps,
      contentEditable: customConfig.customEditable,
      suppressContentEditableWarning: true,
    };
  }

  return elementProps;
};

class DraftEditorBlockNode extends React.Component<Props> {
  shouldComponentUpdate(nextProps: Props): boolean {
    const {block, direction, tree} = this.props;
    const isContainerNode = !block.getChildKeys.isEmpty();
    const blockHasChanged =
      block !== nextProps.block ||
      tree !== nextProps.tree ||
      direction !== nextProps.direction ||
      (isBlockOnSelectionEdge(nextProps.selection, nextProps.block.getKey()) &&
        nextProps.forceSelection);

    // if we have children at this stage we always re-render container nodes
    // else if its a root node we avoid re-rendering by checking for block updates
    return isContainerNode || blockHasChanged;
  }

  /**
   * When a block is mounted and overlaps the selection state, we need to make
   * sure that the cursor is visible to match native behavior. This may not
   * be the case if the user has pressed `RETURN` or pasted some content, since
   * programatically creating these new blocks and setting the DOM selection
   * will miss out on the browser natively scrolling to that position.
   *
   * To replicate native behavior, if the block overlaps the selection state
   * on mount, force the scroll position. Check the scroll state of the scroll
   * parent, and adjust it to align the entire block to the bottom of the
   * scroll parent.
   */
  componentDidMount(): void {
    const selection = this.props.selection;
    const endKey = selection.getEndKey();
    if (!selection.getHasFocus() || endKey !== this.props.block.getKey()) {
      return;
    }

    const blockNode = ReactDOM.findDOMNode(this);
    const scrollParent = Style.getScrollParent(blockNode);
    const scrollPosition = getScrollPosition(scrollParent);
    let scrollDelta;

    if (scrollParent === window) {
      const nodePosition = getElementPosition(blockNode);
      const nodeBottom = nodePosition.y + nodePosition.height;
      const viewportHeight = getViewportDimensions().height;
      scrollDelta = nodeBottom - viewportHeight;
      if (scrollDelta > 0) {
        window.scrollTo(
          scrollPosition.x,
          scrollPosition.y + scrollDelta + SCROLL_BUFFER,
        );
      }
    } else {
      invariant(
        blockNode instanceof HTMLElement,
        'blockNode is not an HTMLElement',
      );
      const blockBottom = blockNode.offsetHeight + blockNode.offsetTop;
      const scrollBottom = scrollParent.offsetHeight + scrollPosition.y;
      scrollDelta = blockBottom - scrollBottom;
      if (scrollDelta > 0) {
        Scroll.setTop(
          scrollParent,
          Scroll.getTop(scrollParent) + scrollDelta + SCROLL_BUFFER,
        );
      }
    }
  }

  render(): React.Node {
    const {
      block,
      blockRenderMap,
      blockRendererFn,
      blockStyleFn,
      contentState,
      decorator,
      editorKey,
      editorState,
      customStyleFn,
      customStyleMap,
      direction,
      forceSelection,
      selection,
      tree,
    } = this.props;

    let children = null;

    if (block.children.size) {
      children = block.children.reduce((acc, key) => {
        const offsetKey = DraftOffsetKey.encode(key, 0, 0);
        const child = contentState.getBlockForKey(key);
        const customConfig = getCustomRenderConfig(child, blockRendererFn);
        const Component = customConfig.CustomComponent || DraftEditorBlockNode;
        const {Element, wrapperTemplate} = getDraftRenderConfig(
          child,
          blockRenderMap,
        );
        const elementProps = getElementPropsConfig(
          child,
          editorKey,
          offsetKey,
          blockStyleFn,
          customConfig,
        );
        const childProps = {
          ...this.props,
          tree: editorState.getBlockTree(key),
          blockProps: customConfig.customProps,
          offsetKey,
          block: child,
        };

        acc.push(
          React.createElement(
            Element,
            elementProps,
            <Component {...childProps} />,
          ),
        );

        if (
          !wrapperTemplate ||
          shouldNotAddWrapperElement(child, contentState)
        ) {
          return acc;
        }

        // if we are here it means we are the last block
        // that has a wrapperTemplate so we should wrap itself
        // and all other previous siblings that share the same wrapper
        applyWrapperElementToSiblings(wrapperTemplate, Element, acc);

        return acc;
      }, []);
    }

    const blockKey = block.getKey();
    const offsetKey = DraftOffsetKey.encode(blockKey, 0, 0);

    const blockNode = (
      <DraftEditorNode
        block={block}
        children={children}
        contentState={contentState}
        customStyleFn={customStyleFn}
        customStyleMap={customStyleMap}
        decorator={decorator}
        direction={direction}
        forceSelection={forceSelection}
        hasSelection={isBlockOnSelectionEdge(selection, blockKey)}
        selection={selection}
        tree={tree}
      />
    );

    if (block.getParentKey()) {
      return blockNode;
    }

    const {Element} = getDraftRenderConfig(block, blockRenderMap);
    const elementProps = getElementPropsConfig(
      block,
      editorKey,
      offsetKey,
      blockStyleFn,
      getCustomRenderConfig(block, blockRendererFn),
    );

    // root block nodes needs to be wrapped
    return React.createElement(Element, elementProps, blockNode);
  }
}

module.exports = DraftEditorBlockNode;
