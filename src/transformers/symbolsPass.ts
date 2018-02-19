/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { TreeVisitor, MultiVisitor, PackedLocation } from '../types';
import { ParsedDocument, NodeUtils } from '../parsedDocument';
import { Phrase, PhraseType } from '../parser/phrase';
import { Token, TokenType } from '../parser/lexer';
import { PhpDoc, PhpDocParser, Tag, MethodTagParam } from '../phpDoc';
import { PhpSymbol, SymbolKind, SymbolModifier, PhpSymbolDoc } from '../symbol';
import { NameResolver } from '../nameResolver';
import { TypeString } from '../typeString';
import { PackedRange } from '../types';
import * as util from '../util';
import { Reference } from '../reference';
import { NodeTransformer, ReferencePhrase } from './transformers';


const RESERVED_WORDS: { [name: string]: number } = {
    'int': 1,
    'string': 1,
    'bool': 1,
    'float': 1,
    'iterable': 1,
    'true': 1,
    'false': 1,
    'null': 1,
    'void': 1,
    'object': 1
};

/** 
 * First parse tree pass
 * 1. Add symbol reference objects to relevant nodes in tree and collect references
 * 2. Build symbol definition tree
 */
export class SymbolsPass implements TreeVisitor<Phrase | Token> {

    lastPhpDoc: PhpDoc;
    lastPhpDocLocation: PackedLocation;
    references: Reference[];

    private _transformerStack: NodeTransformer[];
    private _lastTransformer: NodeTransformer;
    private _utils: NodeUtils;

    constructor(
        public document: ParsedDocument,
        public nameResolver: NameResolver
    ) {
        this._transformerStack = [];
        this.references = [];
    }

    get symbol() {
        return this._lastTransformer ? (<SymbolTransformer>this._lastTransformer).symbol : undefined;
    }

    preorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        let s: PhpSymbol;
        let parentNode = <Phrase>(spine.length ? spine[spine.length - 1] : { phraseType: PhraseType.Unknown, children: [] });
        let parentTransform = this._transformerStack[this._transformerStack.length - 1];

        switch ((<Phrase>node).phraseType) {

            case PhraseType.TopStatementList:
                this._transformerStack.push(new FileTransform(node, this.document.uri, this._utils));
                break;

            case PhraseType.NamespaceDefinitionHeader:
                this._transformerStack.push(new NamespaceDefinitionHeaderTransformer(node));
                break;

            case PhraseType.NamespaceDefinition:
                {
                    const t = new NamespaceDefinitionTransformer(node, this._utils);
                    this._transformerStack.push(t);
                    this.nameResolver.namespace = t.symbol;
                }
                break;

            case PhraseType.NamespaceUseDeclaration:
                this._transformerStack.push(new NamespaceUseDeclarationTransformer(node));
                break;

            case PhraseType.NamespaceUseClause:
            case PhraseType.NamespaceUseGroupClause:
                {
                    const t = new NamespaceUseClauseTransformer(node, (<Phrase>node).phraseType, this._utils);
                    this._transformerStack.push(t);
                    this.nameResolver.rules.push(t.symbol);
                }
                break;

            case PhraseType.NamespaceAliasingClause:
                this._transformerStack.push(new NamespaceAliasingClauseTransformer(node));
                break;

            case PhraseType.ConstElement:
                this._transformerStack.push(
                    new ConstElementTransformer(node, this.nameResolver, this._utils, this.lastPhpDoc, this.lastPhpDocLocation
                    ));
                break;

            case PhraseType.FunctionDeclaration:
                this._transformerStack.push(new FunctionDeclarationTransform(
                    node, this.nameResolver, this._utils, this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case PhraseType.FunctionDeclarationHeader:
                this._transformerStack.push(new FunctionDeclarationHeaderTransform());
                break;

            case PhraseType.ParameterDeclarationList:
                this._transformerStack.push(new DelimiteredListTransformer(PhraseType.ParameterDeclarationList));
                break;

            case PhraseType.ParameterDeclaration:
                this._transformerStack.push(new ParameterDeclarationTransformer(
                    this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation, this.nameResolver
                ));
                break;

            case PhraseType.TypeDeclaration:
                this._transformerStack.push(new TypeDeclarationTransformer());
                break;

            case PhraseType.ReturnType:
                this._transformerStack.push(new ReturnTypeTransform());
                break;

            case PhraseType.FunctionDeclarationBody:
            case PhraseType.MethodDeclarationBody:
                this._transformerStack.push(new FunctionDeclarationBodyTransform((<Phrase>node).phraseType));
                break;

            case PhraseType.ClassDeclaration:
                {
                    let t = new ClassDeclarationTransform(
                        this.nameResolver, this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    );
                    this._transformerStack.push(t);
                    this.nameResolver.pushClass(t.symbol);
                }
                break;

            case PhraseType.ClassDeclarationHeader:
                this._transformerStack.push(new ClassDeclarationHeaderTransform());
                break;

            case PhraseType.ClassBaseClause:
                this._transformerStack.push(new ClassBaseClauseTransformer());
                break;

            case PhraseType.ClassInterfaceClause:
                this._transformerStack.push(new ClassInterfaceClauseTransformer());
                break;

            case PhraseType.QualifiedNameList:
                if (parentTransform) {
                    this._transformerStack.push(new DelimiteredListTransformer(PhraseType.QualifiedNameList));
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case PhraseType.ClassDeclarationBody:
                this._transformerStack.push(new TypeDeclarationBodyTransform(PhraseType.ClassDeclarationBody));
                break;

            case PhraseType.InterfaceDeclaration:
                {
                    let t = new InterfaceDeclarationTransformer(
                        this.nameResolver, this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    );
                    this._transformerStack.push(t);
                    this.nameResolver.pushClass(t.symbol);
                }
                break;

            case PhraseType.InterfaceDeclarationHeader:
                this._transformerStack.push(new InterfaceDeclarationHeaderTransformer());
                break;

            case PhraseType.InterfaceBaseClause:
                this._transformerStack.push(new InterfaceBaseClauseTransformer());
                break;

            case PhraseType.InterfaceDeclarationBody:
                this._transformerStack.push(new TypeDeclarationBodyTransform(PhraseType.InterfaceDeclarationBody));
                break;

            case PhraseType.TraitDeclaration:
                this._transformerStack.push(new TraitDeclarationTransform(
                    this.nameResolver, this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case PhraseType.TraitDeclarationHeader:
                this._transformerStack.push(new TraitDeclarationHeaderTransform());
                break;

            case PhraseType.TraitDeclarationBody:
                this._transformerStack.push(new TypeDeclarationBodyTransform(PhraseType.TraitDeclarationBody));
                break;

            case PhraseType.ClassConstDeclaration:
                this._transformerStack.push(new FieldDeclarationTransform(PhraseType.ClassConstDeclaration));
                break;

            case PhraseType.ClassConstElementList:
                this._transformerStack.push(new DelimiteredListTransformer(PhraseType.ClassConstElementList));
                break;

            case PhraseType.ClassConstElement:
                this._transformerStack.push(new ClassConstantElementTransform(
                    this.nameResolver, this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case PhraseType.PropertyDeclaration:
                this._transformerStack.push(new FieldDeclarationTransform(PhraseType.PropertyDeclaration));
                break;

            case PhraseType.PropertyElementList:
                this._transformerStack.push(new DelimiteredListTransformer(PhraseType.PropertyElementList));
                break;

            case PhraseType.PropertyElement:
                this._transformerStack.push(new PropertyElementTransformer(
                    this.nameResolver, this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case PhraseType.PropertyInitialiser:
                this._transformerStack.push(new PropertyInitialiserTransformer());
                break;

            case PhraseType.TraitUseClause:
                this._transformerStack.push(new TraitUseClauseTransform());
                break;

            case PhraseType.MethodDeclaration:
                this._transformerStack.push(new MethodDeclarationTransform(
                    this.nameResolver, this.document.nodeHashedLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case PhraseType.MethodDeclarationHeader:
                this._transformerStack.push(new MethodDeclarationHeaderTransformer());
                break;

            case PhraseType.Identifier:
                if (parentNode.phraseType === PhraseType.MethodDeclarationHeader || parentNode.phraseType === PhraseType.ClassConstElement) {
                    this._transformerStack.push(new IdentifierTransformer());
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case PhraseType.MemberModifierList:
                this._transformerStack.push(new MemberModifierListTransform());
                break;

            case PhraseType.AnonymousClassDeclaration:
                {
                    let t = new AnonymousClassDeclarationTransform(
                        this.document.nodeHashedLocation(node), this.document.createAnonymousName(<Phrase>node)
                    );
                    this._transformerStack.push(t);
                    this.nameResolver.pushClass(t.symbol);
                }
                break;

            case PhraseType.AnonymousClassDeclarationHeader:
                this._transformerStack.push(new AnonymousClassDeclarationHeaderTransformer());
                break;

            case PhraseType.AnonymousFunctionCreationExpression:
                this._transformerStack.push(new AnonymousFunctionCreationExpressionTransform(
                    this.document.nodeHashedLocation(node), this.document.createAnonymousName(<Phrase>node)
                ));
                break;

            case PhraseType.AnonymousFunctionHeader:
                this._transformerStack.push(new AnonymousFunctionHeaderTransformer());
                break;

            case PhraseType.AnonymousFunctionUseClause:
                this._transformerStack.push(new AnonymousFunctionUseClauseTransform());
                break;

            case PhraseType.ClosureUseList:
                this._transformerStack.push(new DelimiteredListTransformer(PhraseType.ClosureUseList));
                break;

            case PhraseType.AnonymousFunctionUseVariable:
                this._transformerStack.push(new AnonymousFunctionUseVariableTransformer(this.document.nodeHashedLocation(node)));
                break;

            case PhraseType.SimpleVariable:
                this._transformerStack.push(new SimpleVariableTransform(this.document.nodeHashedLocation(node)));
                break;

            case PhraseType.ScopedCallExpression:
                this._transformerStack.push(
                    new MemberAccessExpressionTransform(PhraseType.ScopedCallExpression, SymbolKind.Method, this._referenceSymbols)
                );
                break;

            case PhraseType.ScopedPropertyAccessExpression:
                this._transformerStack.push(
                    new MemberAccessExpressionTransform(PhraseType.ScopedPropertyAccessExpression, SymbolKind.Property, this._referenceSymbols)
                );
                break;

            case PhraseType.ClassConstantAccessExpression:
                this._transformerStack.push(
                    new MemberAccessExpressionTransform(PhraseType.ClassConstantAccessExpression, SymbolKind.ClassConstant, this._referenceSymbols)
                );
                break;

            case PhraseType.PropertyAccessExpression:
                this._transformerStack.push(
                    new MemberAccessExpressionTransform(PhraseType.PropertyAccessExpression, SymbolKind.Property, this._referenceSymbols)
                );
                break;

            case PhraseType.MethodCallExpression:
                this._transformerStack.push(
                    new MemberAccessExpressionTransform(PhraseType.MethodCallExpression, SymbolKind.Method, this._referenceSymbols)
                );
                break;

            case PhraseType.ScopedMemberName:
                this._transformerStack.push(new ScopedMemberNameTransform(<Phrase>node, this.document.nodeHashedLocation(node)));
                break;

            case PhraseType.MemberName:
                this._transformerStack.push(new MemberNameTransform(<Phrase>node, this.document.nodeHashedLocation(node)));
                break;

            case PhraseType.FunctionCallExpression:
                //define
                if ((<Phrase>node).children.length) {
                    const name = this.document.nodeText((<Phrase>node).children[0]).toLowerCase();
                    if (name === 'define' || name === '\\define') {
                        this._transformerStack.push(new DefineFunctionCallExpressionTransform(this.document.nodeHashedLocation(node)));
                        break;
                    }
                }
                this._transformerStack.push(undefined);
                break;

            case PhraseType.ArgumentExpressionList:
                if (parentNode.phraseType === PhraseType.FunctionCallExpression && parentTransform) {
                    this._transformerStack.push(new DelimiteredListTransformer(PhraseType.ArgumentExpressionList));
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case PhraseType.FullyQualifiedName:
                if (parentTransform) {
                    this._transformerStack.push(new FullyQualifiedNameTransformer());
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case PhraseType.RelativeQualifiedName:
                if (parentTransform) {
                    this._transformerStack.push(new RelativeQualifiedNameTransformer(this.nameResolver));
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case PhraseType.QualifiedName:
                if (parentTransform) {
                    this._transformerStack.push(new QualifiedNameTransformer(this.nameResolver));
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case PhraseType.NamespaceName:
                if (parentTransform) {
                    this._transformerStack.push(new NamespaceNameTransformer());
                } else {
                    this._transformerStack.push(null);
                }
                break;

            case undefined:
                //tokens
                if ((<Token>node).tokenType === TokenType.DocumentComment) {

                    this.lastPhpDoc = PhpDocParser.parse(this.document.nodeText(node));
                    this.lastPhpDocLocation = this.document.nodeHashedLocation(node);

                } else if ((<Token>node).tokenType === TokenType.CloseBrace) {

                    this.lastPhpDoc = null;
                    this.lastPhpDocLocation = null;

                } else if ((<Token>node).tokenType === TokenType.VariableName && parentNode.phraseType === PhraseType.CatchClause) {
                    //catch clause vars
                    for (let n = this._transformerStack.length - 1; n > -1; --n) {
                        if (this._transformerStack[n]) {
                            this._transformerStack[n].push(new CatchClauseVariableNameTransform(this.document.tokenText(<Token>node), this.document.nodeHashedLocation(node)));
                            break;
                        }
                    }

                } else if (parentTransform && (<Token>node).tokenType > TokenType.EndOfFile && (<Token>node).tokenType < TokenType.Equals) {

                    parentTransform.push(new TokenTransform(<Token>node, this.document));

                }
                break;

            default:
                if (parentNode.phraseType === PhraseType.ArgumentExpressionList) {
                    const grandParentNode = spine.length > 1 ? spine[spine.length - 2] : undefined;
                    if(parentTransform.node === grandParentNode) {
                        //define func call expr args
                        this._transformerStack.push(new DefaultNodeTransformer(node, (<Phrase>node).phraseType, this._utils));
                    }
                }
                break;
        }

        return true;

    }

    postorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        //tokens dont get a transformer pushed to stack
        if (!(<Phrase>node).phraseType) {
            return;
        }

        const transformer = this._transformerStack[this._transformerStack.length - 1];
        if (transformer.node !== node) {
            //a transformer wasnt pushed to stack for this node
            return;
        }

        this._transformerStack.pop();
        this._lastTransformer = transformer;
        if (this._transformerStack.length > 0) {
            //push transformer to ancestor transformer
            this._transformerStack[this._transformerStack.length - 1].push(transformer);
        }

        //clear last phpdoc and add refs to collection
        switch ((<Phrase>node).phraseType) {
            case PhraseType.ClassDeclarationHeader:
            case PhraseType.InterfaceDeclarationHeader:
            case PhraseType.AnonymousClassDeclarationHeader:
            case PhraseType.FunctionDeclarationHeader:
            case PhraseType.MethodDeclarationHeader:
            case PhraseType.TraitDeclarationHeader:
            case PhraseType.AnonymousFunctionHeader:
                this.lastPhpDoc = null;
                this.lastPhpDocLocation = null;
                break;
            default:
                break;
        }

        switch ((<Phrase>node).phraseType) {
            case PhraseType.FullyQualifiedName:
            case PhraseType.QualifiedName:
            case PhraseType.RelativeQualifiedName:
            case PhraseType.SimpleVariable:
            case PhraseType.MemberName:
            case PhraseType.ScopedMemberName:
            case PhraseType.NamespaceName:
            case PhraseType.ClassDeclarationHeader:
            case PhraseType.InterfaceDeclarationHeader:
            case PhraseType.TraitDeclarationHeader:
            case PhraseType.FunctionDeclarationHeader:
            case PhraseType.ConstElement:
            case PhraseType.PropertyElement:
            case PhraseType.ClassConstElement:
            case PhraseType.MethodDeclarationHeader:
            case PhraseType.ParameterDeclaration:
            case PhraseType.AnonymousFunctionUseVariable:
            case PhraseType.RelativeScope:
                //these nodes will have reference info
                {
                    const ref = (<ReferencePhrase>node).reference;
                    if (Array.isArray(ref)) {
                        for (let n = 0; n < ref.length; ++n) {
                            this.addRefName(ref[n]);
                        }
                    } else {
                        this.addRefName(ref);
                    }

                }
                break;
            default:
                break;
        }

    }

    private addRefName(ref: Reference) {
        if (!ref) {
            return;
        }

        if (ref.name) {
            this.referenceNameSet.add(ref.name);
        }

        if (ref.unresolvedName) {
            this.referenceNameSet.add(ref.unresolvedName);
        }
    }

}

/**
 * Ensures that there are no variable and parameter symbols with same name
 * and excludes inbuilt vars
 */
class UniqueSymbolCollection {

    private _symbols: PhpSymbol[];
    private _varMap: { [index: string]: boolean };
    private static _inbuilt = {
        '$GLOBALS': true,
        '$_SERVER': true,
        '$_GET': true,
        '$_POST': true,
        '$_FILES': true,
        '$_REQUEST': true,
        '$_SESSION': true,
        '$_ENV': true,
        '$_COOKIE': true,
        '$php_errormsg': true,
        '$HTTP_RAW_POST_DATA': true,
        '$http_response_header': true,
        '$argc': true,
        '$argv': true,
        '$this': true
    };

    constructor() {
        this._symbols = [];
        this._varMap = Object.assign({}, UniqueSymbolCollection._inbuilt);
    }

    get length() {
        return this._symbols.length;
    }

    push(s: PhpSymbol) {
        if (s.kind & (SymbolKind.Parameter | SymbolKind.Variable)) {
            if (this._varMap[s.name] === undefined) {
                this._varMap[s.name] = true;
                this._symbols.push(s);
            }
        } else {
            this._symbols.push(s);
        }
    }

    pushMany(symbols: PhpSymbol[]) {
        for (let n = 0, l = symbols.length; n < l; ++n) {
            this.push(symbols[n]);
        }
    }

    toArray() {
        return this._symbols;
    }
}

interface SymbolTransformer extends NodeTransformer {
    symbol: PhpSymbol;
}

interface RangeTransformer extends NodeTransformer {
    range: PackedRange;
}

interface NameTransformer extends NodeTransformer {
    name: string;
    unresolvedName: string;
}

interface TextTransformer extends NodeTransformer {
    text: string;
}

interface SymbolsTransformer extends NodeTransformer {
    symbols: PhpSymbol[];
}

interface ReferenceTransformer extends NodeTransformer {
    reference: Reference;
}

class FileTransform implements SymbolTransformer {

    private _children: UniqueSymbolCollection;
    private _symbol: PhpSymbol;

    constructor(public node: Phrase | Token, uri: string, nodeUtils: NodeUtils) {
        this._symbol = PhpSymbol.create(SymbolKind.File, uri, nodeUtils.nodePackedLocation(this.node));
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransformer) {

        let s = (<SymbolTransformer>transform).symbol;
        if (s) {
            this._children.push(s);
            return;
        }

        let symbols = (<SymbolsTransformer>transform).symbols;
        if (symbols) {
            this._children.pushMany(symbols);
        }

    }

    get symbol() {
        this._symbol.children = this._children.toArray();
        return this._symbol;
    }

}

class MemberAccessExpressionTransform implements NodeTransformer {

    constructor(
        public phraseType: PhraseType,
        public symbolKind: SymbolKind
    ) { }

    push(transformer: NodeTransformer) {

        switch (transformer.phraseType) {
            case PhraseType.ScopedMemberName:
            case PhraseType.MemberName:
                {
                    const reference = (<ReferenceTransformer>transformer).reference;
                    reference.kind = this.symbolKind;
                    if (this.symbolKind === SymbolKind.Property && reference.name && reference.name[0] !== '$') {
                        reference.name = '$' + reference.name;
                    }
                }
                break;

            default:
                break;
        }

    }

}

class MemberNameTransform implements ReferenceTransformer {

    phraseType = PhraseType.MemberName;
    reference: Reference;

    constructor(public node: Phrase, loc: PackedLocation) {
        this.reference = (<ReferencePhrase>node).reference = Reference.create(SymbolKind.None, '', loc.range);
    }

    push(transformer: NodeTransformer) {
        if (transformer.tokenType === TokenType.Name) {
            this.reference.name = (<TokenTransform>transformer).text;
        }
    }

}

class ScopedMemberNameTransform implements ReferenceTransformer {

    phraseType = PhraseType.ScopedMemberName;
    reference: Reference;

    constructor(public node: Phrase, loc: PackedLocation) {
        this.reference = (<ReferencePhrase>node).reference = Reference.create(SymbolKind.None, '', loc.range);
    }

    push(transformer: NodeTransformer) {
        if (
            transformer.tokenType === TokenType.VariableName ||
            transformer.phraseType === PhraseType.Identifier
        ) {
            this.reference.name = (<TextTransformer>transformer).text;
        }
    }

}

class DelimiteredListTransformer implements NodeTransformer {

    transforms: NodeTransformer[];

    constructor(public phraseType: PhraseType) {
        this.transforms = [];
    }

    push(transform: NodeTransformer) {
        this.transforms.push(transform);
    }

}

class TokenTransform implements TextTransformer {

    tokenType: TokenType;

    constructor(
        public node: Phrase | Token,
        public text: string,
        public location: PackedLocation
    ) {
        this.tokenType = (<Token>node).tokenType;
    }
    push(transform: NodeTransformer) { }

}

class NamespaceNameTransformer implements TextTransformer, ReferenceTransformer {

    phraseType = PhraseType.NamespaceName;
    text = '';
    reference: Reference;

    constructor(public node: Phrase, public range: PackedRange) {
        this.reference = (<ReferencePhrase>this.node).reference = Reference.create(SymbolKind.Class, '', range);
    }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.Name) {
            if (this.text) {
                this.text += '\\' + (<TokenTransform>transform).text;
            } else {
                this.text = (<TokenTransform>transform).text;
            }
            this.reference.name = this.text;
        }
    }

}

class QualifiedNameTransformer implements ReferenceTransformer {

    phraseType = PhraseType.QualifiedName;
    reference: Reference;

    constructor(
        public nameResolver: NameResolver,
        private kind: SymbolKind
    ) { }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.NamespaceName) {
            this.reference = (<NamespaceNameTransformer>transformer).reference;
            this.reference.kind = this.kind;
            const unresolvedName = this.reference.name;
            const lcUnresolvedName = unresolvedName.toLowerCase();

            if (RESERVED_WORDS[lcUnresolvedName]) {
                return;
            }

            this.reference.name = this.nameResolver.resolveNotFullyQualified(unresolvedName, this.kind);

            if (
                (this.kind === SymbolKind.Function || this.kind === SymbolKind.Constant) &&
                this.reference.name !== unresolvedName
            ) {
                this.reference.unresolvedName = unresolvedName;
            }

        }
    }

}

class RelativeQualifiedNameTransformer implements ReferenceTransformer {

    phraseType = PhraseType.RelativeQualifiedName;
    reference: Reference;

    constructor(
        public nameResolver: NameResolver,
        private kind: SymbolKind
    ) { }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.NamespaceName) {
            this.reference = (<NamespaceNameTransformer>transformer).reference;
            this.reference.name = this.nameResolver.resolveRelative(this.reference.name);
            this.reference.kind = this.kind;
        }
    }

}

class FullyQualifiedNameTransformer implements ReferenceTransformer {

    phraseType = PhraseType.FullyQualifiedName;
    reference: Reference;

    constructor(private kind: SymbolKind) { }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.NamespaceName) {
            this.reference = (<NamespaceNameTransformer>transformer).reference;
            this.reference.kind = this.kind;
        }
    }

}

class CatchClauseVariableNameTransform implements SymbolTransformer, ReferenceTransformer {
    tokenType = TokenType.VariableName;
    symbol: PhpSymbol;
    reference: Reference;

    constructor(name: string, location: PackedLocation) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, name, location);
        this.reference = Reference.create(SymbolKind.Variable, name, location.range);
    }
    push(transform: NodeTransformer) { }
}

class ParameterDeclarationTransformer implements SymbolTransformer, ReferenceTransformer {

    phraseType = PhraseType.ParameterDeclaration;
    symbol: PhpSymbol;
    reference: Reference;

    constructor(
        public node: Phrase,
        private location: PackedLocation,
        private doc: PhpDoc,
        private docLocation: PackedLocation,
        private nameResolver: NameResolver
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Parameter, '', location);
    }

    push(transform: NodeTransformer) {
        if (transform.phraseType === PhraseType.TypeDeclaration) {
            this.symbol.type = (<TypeDeclarationTransformer>transform).type;
        } else if (transform.tokenType === TokenType.Ampersand) {
            this.symbol.modifiers |= SymbolModifier.Reference;
        } else if (transform.tokenType === TokenType.Ellipsis) {
            this.symbol.modifiers |= SymbolModifier.Variadic;
        } else if (transform.tokenType === TokenType.VariableName) {
            this.reference = Reference.create(
                SymbolKind.Parameter,
                (<TokenTransform>transform).text,
                (<TokenTransform>transform).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
            this.symbol.name = this.reference.name;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this.doc, this.docLocation, this.nameResolver);
        } else {
            this.symbol.value = (<TextTransformer>transform).text;
        }
    }

}

class DefineFunctionCallExpressionTransform implements SymbolTransformer {

    phraseType = PhraseType.FunctionCallExpression;
    symbol: PhpSymbol;
    reference: Reference

    constructor(
        public node: Phrase,
        private location: PackedLocation
    ) { }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.ArgumentExpressionList) {

            let arg1: TextTransformer, arg2: TextTransformer;
            [arg1, arg2] = (<DelimiteredListTransformer>transformer).transforms as TextTransformer[];

            if (arg1 && arg1.tokenType === TokenType.StringLiteral) {
                let constName = arg1.text.slice(1, -1); //remove quotes
                if (constName && constName[0] === '\\') {
                    constName = constName.slice(1);
                }
                this.symbol = PhpSymbol.create(SymbolKind.Constant, constName, this.location);
                this.reference = Reference.create(SymbolKind.Constant, constName, (<TokenTransform>arg1).location.range);
                (<ReferencePhrase>this.node).reference = this.reference;
            }

            //this could be an array or scalar expression too
            //could resolve scalar expression in type pass to a value and type
            //but array may be too large to add as value here
            if (
                arg2 &&
                (
                    arg2.tokenType === TokenType.FloatingLiteral ||
                    arg2.tokenType === TokenType.IntegerLiteral ||
                    arg2.tokenType === TokenType.StringLiteral
                )
            ) {
                this.symbol.value = arg2.text;
                this.symbol.type = SymbolReader.tokenTypeToPhpType(arg2.tokenType);
            }

        }
    }

}

class SimpleVariableTransform implements SymbolTransformer, ReferenceTransformer {

    phraseType = PhraseType.SimpleVariable;
    symbol: PhpSymbol;
    /**
     * dynamic variables dont get a reference
     */
    reference: Reference;

    constructor(public node: Phrase, private location: PackedLocation) { }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.VariableName) {
            this.symbol = PhpSymbol.create(SymbolKind.Variable, (<TokenTransform>transform).text, this.location);
            this.reference = Reference.create(SymbolKind.Variable, this.symbol.name, this.location.range);
            (<ReferencePhrase>this.node).reference = this.reference;
        }
    }

}

class AnonymousClassDeclarationTransform implements SymbolTransformer {

    phraseType = PhraseType.AnonymousClassDeclaration;
    symbol: PhpSymbol;

    constructor(location: PackedLocation, name: string) {
        this.symbol = PhpSymbol.create(SymbolKind.Class, name, location);
        this.symbol.modifiers = SymbolModifier.Anonymous;
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransformer) {
        if (transform.phraseType === PhraseType.AnonymousClassDeclarationHeader) {
            if ((<AnonymousClassDeclarationHeaderTransformer>transform).base) {
                this.symbol.associated.push((<AnonymousClassDeclarationHeaderTransformer>transform).base);
            }
            Array.prototype.push.apply(this.symbol.associated, (<AnonymousClassDeclarationHeaderTransformer>transform).associated);
        } else if (transform.phraseType === PhraseType.ClassDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name))
            Array.prototype.push.apply(this.symbol.associated, (<TypeDeclarationBodyTransform>transform).useTraits);
        }
    }

}

class TypeDeclarationBodyTransform implements NodeTransformer {

    declarations: PhpSymbol[];
    useTraits: PhpSymbol[];

    constructor(public phraseType: PhraseType) {
        this.declarations = [];
        this.useTraits = [];
    }

    push(transform: NodeTransformer) {

        switch (transform.phraseType) {
            case PhraseType.ClassConstDeclaration:
            case PhraseType.PropertyDeclaration:
                Array.prototype.push.apply(this.declarations, (<FieldDeclarationTransform>transform).symbols);
                break;

            case PhraseType.MethodDeclaration:
                this.declarations.push((<MethodDeclarationTransform>transform).symbol);
                break;

            case PhraseType.TraitUseClause:
                Array.prototype.push.apply(this.useTraits, (<TraitUseClauseTransform>transform).symbols);
                break;

            default:
                break;

        }
    }

}

class AnonymousClassDeclarationHeaderTransformer implements NodeTransformer {

    phraseType = PhraseType.AnonymousClassDeclarationHeader;
    associated: Reference[];

    constructor() {
        this.associated = [];
    }

    push(transformer: NodeTransformer) {

        if (
            transformer.phraseType === PhraseType.FullyQualifiedName ||
            transformer.phraseType === PhraseType.QualifiedName ||
            transformer.phraseType === PhraseType.RelativeQualifiedName
        ) {
            //names from base clause and interface clause
            const ref = (<ReferenceTransformer>transformer).reference;
            if (ref) {
                this.associated.push(ref);
            }
        }

    }

}

class AnonymousFunctionCreationExpressionTransform implements SymbolTransformer {

    phraseType = PhraseType.AnonymousFunctionCreationExpression;
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(location: PackedLocation, name: string) {
        this._symbol = PhpSymbol.create(SymbolKind.Function, name, location);
        this._symbol.modifiers = SymbolModifier.Anonymous;
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransformer) {
        if (transform.phraseType === PhraseType.AnonymousFunctionHeader) {
            this._symbol.modifiers |= (<AnonymousFunctionHeaderTransformer>transform).modifier;
            this._children.pushMany((<AnonymousFunctionHeaderTransformer>transform).parameters);
            this._children.pushMany((<AnonymousFunctionHeaderTransformer>transform).uses);
            this._symbol.type = (<AnonymousFunctionHeaderTransformer>transform).returnType;
        } else if (transform.phraseType === PhraseType.FunctionDeclarationBody) {
            this._children.pushMany((<FunctionDeclarationBodyTransform>transform).symbols);
        }
    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class AnonymousFunctionHeaderTransformer implements NodeTransformer {

    phraseType = PhraseType.AnonymousFunctionHeader;
    modifier = SymbolModifier.None;
    parameters: PhpSymbol[];
    uses: PhpSymbol[];
    returnType = '';

    constructor() {
        this.parameters = [];
        this.uses = [];
    }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.Ampersand) {
            this.modifier |= SymbolModifier.Reference;
        } else if (transform.tokenType === TokenType.Static) {
            this.modifier |= SymbolModifier.Static;
        } else if (transform.phraseType === PhraseType.ParameterDeclaration) {
            const s = (<ParameterDeclarationTransformer>transform).symbol;
            if (s) {
                this.parameters.push(s);
            }
        } else if (transform.phraseType === PhraseType.AnonymousFunctionUseVariable) {
            const s = (<AnonymousFunctionUseVariableTransformer>transform).symbol;
            if (s) {
                this.uses.push(s);
            }
        } else if (transform.phraseType === PhraseType.TypeDeclaration) {
            this.returnType = (<TypeDeclarationTransformer>transform).type;
        }
    }

}

class FunctionDeclarationBodyTransform implements SymbolsTransformer {

    private _value: UniqueSymbolCollection;

    constructor(public phraseType: PhraseType) {
        this._value = new UniqueSymbolCollection();
    }

    push(transform: NodeTransformer) {

        switch (transform.phraseType) {
            case PhraseType.SimpleVariable:
            case PhraseType.AnonymousFunctionCreationExpression:
            case PhraseType.AnonymousClassDeclaration:
            case PhraseType.FunctionCallExpression: //define    
                this._value.push((<SymbolTransformer>transform).symbol);
                break;

            case undefined:
                //catch clause vars
                if (transform instanceof CatchClauseVariableNameTransform) {
                    this._value.push(transform.symbol);
                }
                break;

            default:
                break;
        }

    }

    get symbols() {
        return this._value.toArray();
    }

}

class AnonymousFunctionUseVariableTransformer implements SymbolTransformer, ReferenceTransformer {

    phraseType = PhraseType.AnonymousFunctionUseVariable;
    reference: Reference;
    symbol: PhpSymbol;

    constructor(public node: Phrase, private location: PackedLocation) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, '', location);
        this.symbol.modifiers = SymbolModifier.Use;
    }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.Ampersand) {
            this.symbol.modifiers |= SymbolModifier.Reference;
        } else if (transform.tokenType === TokenType.VariableName) {
            this.symbol.name = (<TokenTransform>transform).text;
            this.reference = Reference.create(
                SymbolKind.Variable,
                this.symbol.name,
                (<TokenTransform>transform).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
        }
    }

}

class InterfaceDeclarationTransformer implements SymbolTransformer {

    phraseType = PhraseType.InterfaceDeclaration;
    symbol: PhpSymbol;

    constructor(
        public nameResolver: NameResolver,
        location: PackedLocation,
        doc: PhpDoc,
        docLocation: PackedLocation
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Interface, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
        this.symbol.children = [];
    }

    push(transform: NodeTransformer) {
        if (transform.phraseType === PhraseType.InterfaceDeclarationHeader) {
            this.symbol.name = this.nameResolver.resolveRelative((<InterfaceDeclarationHeaderTransformer>transform).name);
            this.symbol.associated = (<InterfaceDeclarationHeaderTransformer>transform).extends;
        } else if (transform.phraseType === PhraseType.InterfaceDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name));
        }
    }

}

class ConstElementTransformer implements SymbolTransformer {

    phraseType = PhraseType.ConstElement;
    symbol: PhpSymbol;
    reference: Reference;

    constructor(
        public node: Phrase|Token,
        public nameResolver: NameResolver,
        private utils:NodeUtils,
        private doc: PhpDoc,
        private docLocation: PackedLocation
    ) {

        this.symbol = PhpSymbol.create(SymbolKind.Constant, '', this.utils.nodePackedLocation(node));
        this.symbol.scope = this.nameResolver.namespaceName;
        this.reference = Reference.create(SymbolKind.Constant, '', this.symbol.location.range);
        (<ReferencePhrase>this.node).reference = this.reference;
    }

    push(transformer: NodeTransformer) {

        if (transformer.tokenType === TokenType.Name) {
            this.symbol.name = this.nameResolver.resolveRelative((<TokenTransform>transformer).text);
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this.doc, this.docLocation, this.nameResolver);
            this.reference.name = this.symbol.name;
            this.reference.range = (<TokenTransform>transformer).location.range;
            SymbolReader.assignTypeToReference(this.symbol.type, <Reference>(<ReferencePhrase>this.node).reference);
        } else if (
            transformer.tokenType === TokenType.StringLiteral ||
            transformer.tokenType === TokenType.IntegerLiteral ||
            transformer.tokenType === TokenType.FloatingLiteral
        ) {
            //could also be any scalar expression or array
            //handle in types pass ?
            this.symbol.value = (<TextTransformer>transformer).text;
            this.symbol.type = SymbolReader.tokenTypeToPhpType(transformer.tokenType);
            SymbolReader.assignTypeToReference(this.symbol.type, <Reference>(<ReferencePhrase>this.node).reference);
        }

    }

}

class TraitDeclarationTransform implements SymbolTransformer {

    phraseType = PhraseType.TraitDeclaration;
    symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: PackedLocation, doc: PhpDoc, docLocation: PackedLocation) {
        this.symbol = PhpSymbol.create(SymbolKind.Trait, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransformer) {
        if (transform.phraseType === PhraseType.TraitDeclarationHeader) {
            this.symbol.name = this.nameResolver.resolveRelative((<TraitDeclarationHeaderTransform>transform).name);
        } else if (transform.phraseType === PhraseType.TraitDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name));
            Array.prototype.push.apply(this.symbol.associated, (<TypeDeclarationBodyTransform>transform).useTraits);
        }
    }

}

class TraitDeclarationHeaderTransform implements NodeTransformer {
    phraseType = PhraseType.TraitDeclarationHeader;
    name = '';
    reference: Reference;

    constructor(public node: Phrase, public nameResolver: NameResolver) { }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.Name) {
            this.name = (<TokenTransform>transform).text;
            this.reference = Reference.create(
                SymbolKind.Trait,
                this.nameResolver.resolveRelative(this.name),
                (<TokenTransform>transform).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
        }
    }

}

class InterfaceDeclarationHeaderTransformer implements ReferenceTransformer {
    phraseType = PhraseType.InterfaceDeclarationHeader;
    name = '';
    associated: Reference[];
    reference: Reference;

    constructor(public node: Phrase, public nameResolver: NameResolver) {
        this.associated = [];
    }

    push(transformer: NodeTransformer) {
        if (transformer.tokenType === TokenType.Name) {
            this.name = (<TokenTransform>transformer).text;
            this.reference = Reference.create(
                SymbolKind.Interface,
                this.nameResolver.resolveRelative(this.name),
                (<TokenTransform>transformer).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
        } else if (
            transformer.phraseType === PhraseType.FullyQualifiedName ||
            transformer.phraseType === PhraseType.QualifiedName ||
            transformer.phraseType === PhraseType.RelativeQualifiedName
        ) {
            //names from base clause and interface clause
            const ref = (<ReferenceTransformer>transformer).reference;
            if (ref) {
                this.associated.push(ref);
            }
        }
    }

}

class TraitUseClauseTransform implements NodeTransformer {

    phraseType = PhraseType.TraitUseClause;
    references: Reference[];

    constructor() {
        this.references = [];
    }

    push(transformer: NodeTransformer) {
        if (
            transformer.phraseType === PhraseType.FullyQualifiedName ||
            transformer.phraseType === PhraseType.QualifiedName ||
            transformer.phraseType === PhraseType.RelativeQualifiedName
        ) {
            const ref = (<ReferenceTransformer>transformer).reference;
            if (ref) {
                this.references.push(ref);
            }
        }
    }

}

class NamespaceDefinitionHeaderTransformer implements TextTransformer {

    phraseType = PhraseType.NamespaceDefinitionHeader;
    text = '';

    constructor(public node: Phrase | Token) { }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.NamespaceName) {
            this.text = (<NamespaceNameTransformer>transformer).text;
        }
    }

}

class NamespaceDefinitionTransformer implements SymbolTransformer {

    phraseType = PhraseType.NamespaceDefinition;
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(public node: Phrase | Token, private utils: NodeUtils) {
        this._symbol = PhpSymbol.create(SymbolKind.Namespace, '', utils.nodePackedLocation(node));
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransformer) {
        if (transform.phraseType === PhraseType.NamespaceDefinitionHeader) {
            this._symbol.name = (<NamespaceDefinitionHeaderTransformer>transform).text;
        } else {
            let s = (<SymbolTransformer>transform).symbol;
            if (s) {
                this._children.push(s);
                return;
            }

            let symbols = (<SymbolsTransformer>transform).symbols;
            if (symbols) {
                this._children.pushMany(symbols);
            }
        }
    }

    get symbol() {
        if (this._children.length > 0) {
            this._symbol.children = this._children.toArray();
        }

        return this._symbol;
    }
}

class ClassDeclarationTransform implements SymbolTransformer {

    phraseType = PhraseType.ClassDeclaration;
    symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: PackedLocation, doc: PhpDoc, docLocation: PackedLocation) {
        this.symbol = PhpSymbol.create(SymbolKind.Class, '', location);
        this.symbol.children = [];
        this.symbol.associated = [];
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
    }

    push(transform: NodeTransformer) {

        if (transform instanceof ClassDeclarationHeaderTransform) {
            this.symbol.modifiers = transform.modifier;
            this.symbol.name = this.nameResolver.resolveRelative(transform.name);
            if (transform.extends) {
                this.symbol.associated.push(transform.extends);
            }
            Array.prototype.push.apply(this.symbol.associated, transform.implements);
        } else if (transform.phraseType === PhraseType.ClassDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name));
            Array.prototype.push.apply(this.symbol.associated, (<TypeDeclarationBodyTransform>transform).useTraits);
        }

    }

}

class ClassDeclarationHeaderTransform implements NodeTransformer {

    phraseType = PhraseType.ClassDeclarationHeader;
    modifier = SymbolModifier.None;
    name = '';
    associated: Reference[];
    reference: Reference;

    constructor(public node: Phrase, public nameResolver: NameResolver) {
        this.associated = [];
    }

    push(transform: NodeTransformer) {

        if (transform.tokenType === TokenType.Abstract) {
            this.modifier = SymbolModifier.Abstract;
        } else if (transform.tokenType === TokenType.Final) {
            this.modifier = SymbolModifier.Final;
        } else if (transform.tokenType === TokenType.Name) {
            this.name = (<TokenTransform>transform).text;
            this.reference = Reference.create(
                SymbolKind.Class,
                this.nameResolver.resolveRelative(this.name),
                (<TokenTransform>transform).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
        } else if (
            transform.phraseType === PhraseType.FullyQualifiedName ||
            transform.phraseType === PhraseType.QualifiedName ||
            transform.phraseType === PhraseType.RelativeQualifiedName
        ) {
            //these will be names from class base clause and class interface clause
            const ref = (<ReferenceTransformer>transform).reference;
            if (ref) {
                this.associated.push(ref);
            }
        }

    }

}

class MemberModifierListTransform implements NodeTransformer {

    phraseType = PhraseType.MemberModifierList;
    modifiers = SymbolModifier.None;

    push(transform: NodeTransformer) {
        switch (transform.tokenType) {
            case TokenType.Public:
                this.modifiers |= SymbolModifier.Public;
                break;
            case TokenType.Protected:
                this.modifiers |= SymbolModifier.Protected;
                break;
            case TokenType.Private:
                this.modifiers |= SymbolModifier.Private;
                break;
            case TokenType.Abstract:
                this.modifiers |= SymbolModifier.Abstract;
                break;
            case TokenType.Final:
                this.modifiers |= SymbolModifier.Final;
                break;
            case TokenType.Static:
                this.modifiers |= SymbolModifier.Static;
                break;
            default:
                break;
        }
    }

}

class ClassConstantElementTransform implements SymbolTransformer, ReferenceTransformer {

    phraseType = PhraseType.ClassConstElement;
    symbol: PhpSymbol;
    reference: Reference;

    constructor(
        public node: Phrase,
        public nameResolver: NameResolver,
        private location: PackedLocation,
        private doc: PhpDoc,
        private docLocation: PackedLocation
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.ClassConstant, '', location);
        this.symbol.modifiers = SymbolModifier.Static;
    }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.Identifier) {
            this.symbol.name = (<IdentifierTransformer>transformer).text;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this.doc, this.docLocation, this.nameResolver);
            (<ReferencePhrase>this.node).reference = Reference.create(
                SymbolKind.ClassConstant,
                this.symbol.name,
                (<IdentifierTransformer>transformer).location.range
            );
        } else if (
            transformer.tokenType === TokenType.StringLiteral ||
            transformer.tokenType === TokenType.IntegerLiteral ||
            transformer.tokenType === TokenType.FloatingLiteral
        ) {
            //could also be any scalar expression or array
            //handle in types pass ?
            this.symbol.value = (<TextTransformer>transformer).text;
            this.symbol.type = SymbolReader.tokenTypeToPhpType(transformer.tokenType);
        }
    }

}

class MethodDeclarationTransform implements SymbolTransformer {

    phraseType = PhraseType.MethodDeclaration;
    private _children: UniqueSymbolCollection;
    private _symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: PackedLocation, doc: PhpDoc, docLocation: PackedLocation) {
        this._symbol = PhpSymbol.create(SymbolKind.Method, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this._symbol, doc, docLocation, nameResolver);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransformer) {

        if (transform instanceof MethodDeclarationHeaderTransformer) {
            this._symbol.modifiers = transform.modifiers;
            this._symbol.name = transform.name;
            this._children.pushMany(transform.parameters);
            this._symbol.type = transform.returnType;
        } else if (transform.phraseType === PhraseType.MethodDeclarationBody) {
            this._children.pushMany((<FunctionDeclarationBodyTransform>transform).symbols);
        }

    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class TypeDeclarationTransformer implements NodeTransformer {

    phraseType = PhraseType.TypeDeclaration;
    type = '';

    push(transform: NodeTransformer) {

        switch (transform.phraseType) {
            case PhraseType.FullyQualifiedName:
            case PhraseType.RelativeQualifiedName:
            case PhraseType.QualifiedName:
                this.type = (<NameTransformer>transform).name;
                break;

            case undefined:
                if (transform.tokenType === TokenType.Callable) {
                    this.type = 'callable';
                } else if (transform.tokenType === TokenType.Array) {
                    this.type = 'array';
                }
                break;

            default:
                break;
        }

    }

}

class IdentifierTransformer implements TextTransformer {

    phraseType = PhraseType.Identifier;
    text = '';
    location: PackedLocation;

    push(transformer: NodeTransformer) {
        this.text = (<TokenTransform>transformer).text;
        this.location = (<TokenTransform>transformer).location;
    }

}

class MethodDeclarationHeaderTransformer implements NodeTransformer, ReferenceTransformer {

    phraseType = PhraseType.MethodDeclarationHeader;
    modifiers = SymbolModifier.Public;
    name = '';
    parameters: PhpSymbol[];
    returnType = '';
    reference: Reference;

    constructor(public node: Phrase, public nameResolver: NameResolver) {
        this.parameters = [];
    }

    push(transformer: NodeTransformer) {
        switch (transformer.phraseType) {
            case PhraseType.MemberModifierList:
                this.modifiers = (<MemberModifierListTransform>transformer).modifiers;
                if (!(this.modifiers & (SymbolModifier.Public | SymbolModifier.Protected | SymbolModifier.Private))) {
                    this.modifiers |= SymbolModifier.Public;
                }
                break;

            case PhraseType.Identifier:
                this.name = (<IdentifierTransformer>transformer).text;
                this.reference = Reference.create(
                    SymbolKind.Method,
                    this.name,
                    (<IdentifierTransformer>transformer).location.range
                );
                (<ReferencePhrase>this.node).reference = this.reference;
                break;

            case PhraseType.ParameterDeclaration:
                {
                    const s = (<ParameterDeclarationTransformer>transformer).symbol;
                    if (s) {
                        this.parameters.push(s);
                    }
                }
                break;

            case PhraseType.TypeDeclaration:
                this.returnType = (<TypeDeclarationTransformer>transformer).type;
                break;

            default:
                break;
        }
    }

}

class PropertyInitialiserTransformer implements NodeTransformer {

    phraseType = PhraseType.PropertyInitialiser;
    text = '';

    push(transformer: NodeTransformer) {
        this.text = (<TextTransformer>transformer).text;
    }

}

class PropertyElementTransformer implements SymbolTransformer, ReferenceTransformer {

    phraseType = PhraseType.PropertyElement;
    symbol: PhpSymbol;
    reference: Reference;

    constructor(
        public node: Phrase,
        public nameResolver: NameResolver,
        private location: PackedLocation,
        private doc: PhpDoc,
        private docLocation: PackedLocation
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Property, '', location);
    }

    push(transformer: NodeTransformer) {

        if (transformer.tokenType === TokenType.VariableName) {
            this.symbol.name = (<TokenTransform>transformer).text;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this.doc, this.docLocation, this.nameResolver);
            this.reference = Reference.create(
                SymbolKind.Property,
                this.symbol.name,
                (<TokenTransform>transformer).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
        } else if (transformer.phraseType === PhraseType.PropertyInitialiser) {
            //this.symbol.value = (<PropertyInitialiserTransformer>transform).text;
        }

    }

}

class FieldDeclarationTransform implements SymbolsTransformer {

    private _modifier = SymbolModifier.Public;
    symbols: PhpSymbol[];

    constructor(public phraseType: PhraseType, private elementType: PhraseType) {
        this.symbols = [];
    }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.MemberModifierList) {
            this._modifier = (<MemberModifierListTransform>transformer).modifiers;
        } else if (transformer.phraseType === this.elementType) {
            const s = (<SymbolTransformer>transformer).symbol;
            if (s) {
                s.modifiers |= this._modifier;
                this.symbols.push(s);
            }
        }
    }

}

class FunctionDeclarationTransform implements SymbolTransformer {

    phraseType = PhraseType.FunctionDeclaration;
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(
        public node:Phrase|Token,
        public nameResolver: NameResolver,
        private utils:NodeUtils,
        private phpDoc: PhpDoc,
        private phpDocLocation: PackedLocation
    ) {
        this._symbol = PhpSymbol.create(SymbolKind.Function, '', utils.nodePackedLocation(node));
        SymbolReader.assignPhpDocInfoToSymbol(this._symbol, phpDoc, phpDocLocation, nameResolver);
        this._children = new UniqueSymbolCollection();
    }

    push(transformer: NodeTransformer) {
        if (transformer.phraseType === PhraseType.FunctionDeclarationHeader) {
            this._symbol.name = (<FunctionDeclarationHeaderTransform>transformer).name;
            this._children.pushMany((<FunctionDeclarationHeaderTransform>transformer).parameters);
            this._symbol.type = (<FunctionDeclarationHeaderTransform>transformer).returnType;
        } else {
            const s = (<SymbolTransformer>transformer).symbol;
            if(s) {
                this._children.push(s);
            }
        }
    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class FunctionDeclarationHeaderTransform implements NodeTransformer, ReferenceTransformer {

    phraseType = PhraseType.FunctionDeclarationHeader;
    name = '';
    parameters: PhpSymbol[];
    returnType = '';
    reference: Reference;

    constructor(public node: Phrase, public nameResolver: NameResolver) {
        this.parameters = [];
    }

    push(transformer: NodeTransformer) {

        if (transformer.tokenType === TokenType.Name) {
            this.name = this.nameResolver.resolveRelative((<TokenTransform>transformer).text);
            this.reference = Reference.create(
                SymbolKind.Function,
                this.name,
                (<TokenTransform>transformer).location.range
            );
            (<ReferencePhrase>this.node).reference = this.reference;
        } else if (transformer.phraseType === PhraseType.ParameterDeclaration) {
            const s = (<ParameterDeclarationTransformer>transformer).symbol;
            if (s) {
                this.parameters.push(s);
            }
        } else if (transformer.phraseType === PhraseType.TypeDeclaration) {
            this.returnType = (<TypeDeclarationTransformer>transformer).type;
        }
    }
}

class DefaultNodeTransformer implements TextTransformer {

    constructor(public node:Phrase|Token, public phraseType: PhraseType, private utils:NodeUtils) { }
    push(transform: NodeTransformer) { }
    get text() {
        return this.utils.nodeText(this.node);
    }
}

export namespace SymbolReader {

    export function tokenTypeToPhpType(tokenType: TokenType) {
        switch (tokenType) {
            case TokenType.StringLiteral:
                return 'string';
            case TokenType.IntegerLiteral:
                return 'int';
            case TokenType.FloatingLiteral:
                return 'float';
            default:
                return '';
        }
    }

    export function assignTypeToReference(type: string, ref: Reference) {
        //@todo handle this better in cases where a doc block type hint may be more
        //specific than a type declaration eg array or object

        if (!ref.type) {
            ref.type = type;
        }
    }

    export function assignPhpDocInfoToSymbol(s: PhpSymbol, doc: PhpDoc, docLocation: PackedLocation, nameResolver: NameResolver) {

        if (!doc) {
            return s;
        }
        let tag: Tag;

        switch (s.kind) {
            case SymbolKind.Property:
            case SymbolKind.ClassConstant:
                tag = doc.findVarTag(s.name);
                if (tag) {
                    s.doc = PhpSymbolDoc.create(tag.description, TypeString.nameResolve(tag.typeString, nameResolver));
                }
                break;

            case SymbolKind.Method:
            case SymbolKind.Function:
                tag = doc.returnTag;
                s.doc = PhpSymbolDoc.create(doc.text);
                if (tag) {
                    s.doc.type = TypeString.nameResolve(tag.typeString, nameResolver);
                }
                break;

            case SymbolKind.Parameter:
                tag = doc.findParamTag(s.name);
                if (tag) {
                    s.doc = PhpSymbolDoc.create(tag.description, TypeString.nameResolve(tag.typeString, nameResolver));
                }
                break;

            case SymbolKind.Class:
            case SymbolKind.Trait:
            case SymbolKind.Interface:
                s.doc = PhpSymbolDoc.create(doc.text);
                if (!s.children) {
                    s.children = [];
                }
                Array.prototype.push.apply(s.children, phpDocMembers(doc, docLocation, nameResolver));
                break;

            default:
                break;

        }

        return s;

    }

    export function phpDocMembers(phpDoc: PhpDoc, phpDocLoc: PackedLocation, nameResolver: NameResolver) {

        let magic: Tag[] = phpDoc.propertyTags;
        let symbols: PhpSymbol[] = [];

        for (let n = 0, l = magic.length; n < l; ++n) {
            symbols.push(propertyTagToSymbol(magic[n], phpDocLoc, nameResolver));
        }

        magic = phpDoc.methodTags;
        for (let n = 0, l = magic.length; n < l; ++n) {
            symbols.push(methodTagToSymbol(magic[n], phpDocLoc, nameResolver));
        }

        return symbols;
    }

    function methodTagToSymbol(tag: Tag, phpDocLoc: PackedLocation, nameResolver: NameResolver) {

        let s = PhpSymbol.create(SymbolKind.Method, tag.name, phpDocLoc);
        s.modifiers = SymbolModifier.Magic | SymbolModifier.Public;
        s.doc = PhpSymbolDoc.create(tag.description, TypeString.nameResolve(tag.typeString, nameResolver));
        s.children = [];

        if (tag.isStatic) {
            s.modifiers |= SymbolModifier.Static;
        }

        if (!tag.parameters) {
            return s;
        }

        for (let n = 0, l = tag.parameters.length; n < l; ++n) {
            s.children.push(magicMethodParameterToSymbol(tag.parameters[n], phpDocLoc, nameResolver));
        }

        return s;
    }

    function magicMethodParameterToSymbol(p: MethodTagParam, phpDocLoc: PackedLocation, nameResolver: NameResolver) {

        let s = PhpSymbol.create(SymbolKind.Parameter, p.name, phpDocLoc);
        s.modifiers = SymbolModifier.Magic;
        s.doc = PhpSymbolDoc.create(undefined, TypeString.nameResolve(p.typeString, nameResolver));
        return s;

    }

    function propertyTagToSymbol(t: Tag, phpDocLoc: PackedLocation, nameResolver: NameResolver) {
        let s = PhpSymbol.create(SymbolKind.Property, t.name, phpDocLoc);
        s.modifiers = magicPropertyModifier(t) | SymbolModifier.Magic | SymbolModifier.Public;
        s.doc = PhpSymbolDoc.create(t.description, TypeString.nameResolve(t.typeString, nameResolver));
        return s;
    }

    function magicPropertyModifier(t: Tag) {
        switch (t.tagName) {
            case '@property-read':
                return SymbolModifier.ReadOnly;
            case '@property-write':
                return SymbolModifier.WriteOnly;
            default:
                return SymbolModifier.None;
        }
    }

    export function modifierListToSymbolModifier(phrase: Phrase) {

        if (!phrase) {
            return 0;
        }

        let flag = SymbolModifier.None;
        let tokens = phrase.children || [];

        for (let n = 0, l = tokens.length; n < l; ++n) {
            flag |= modifierTokenToSymbolModifier(<Token>tokens[n]);
        }

        return flag;
    }

    export function modifierTokenToSymbolModifier(t: Token) {
        switch (t.tokenType) {
            case TokenType.Public:
                return SymbolModifier.Public;
            case TokenType.Protected:
                return SymbolModifier.Protected;
            case TokenType.Private:
                return SymbolModifier.Private;
            case TokenType.Abstract:
                return SymbolModifier.Abstract;
            case TokenType.Final:
                return SymbolModifier.Final;
            case TokenType.Static:
                return SymbolModifier.Static;
            default:
                return SymbolModifier.None;
        }

    }

}

class NamespaceUseDeclarationTransformer implements SymbolsTransformer {

    phraseType = PhraseType.NamespaceUseDeclaration;
    symbols: PhpSymbol[];
    private _kind = SymbolKind.Class;
    private _prefix = '';

    constructor(public node:Phrase|Token) {
        this.symbols = [];
    }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.Const) {
            this._kind = SymbolKind.Constant;
        
        } else if (transform.tokenType === TokenType.Function) {
            this._kind = SymbolKind.Function;
        
        } else if (transform.phraseType === PhraseType.NamespaceName) {

            this._prefix = (<NamespaceNameTransformer>transform).text;
            (<NamespaceNameTransformer>transform).reference.kind = SymbolKind.Namespace;
        
        } else if (
            transform.phraseType === PhraseType.NamespaceUseGroupClause || 
            transform.phraseType === PhraseType.NamespaceUseClause
        ) {

            const s = (<NamespaceUseClauseTransformer>transform).symbol;
            const prefix = this._prefix ? this._prefix + '\\' : '';
            const refs = (<NamespaceUseClauseTransformer>transform).references;
            if(!s.kind) {
                s.kind = this._kind;
            }
            refs.forEach(x => {
                x.name = prefix + x.name;
                x.kind = s.kind;
            });
            this.symbols.push(s);

        }
    }

}

class NamespaceUseClauseTransformer implements NodeTransformer {

    symbol: PhpSymbol;
    /**
     * a reference for namespace name and a reference for alias
     */
    references: Reference[];

    constructor(public node:Phrase | Token, public phraseType: PhraseType, private utils:NodeUtils) {
        this.symbol = PhpSymbol.create(0, '', utils.nodePackedLocation(node));
        this.symbol.modifiers = SymbolModifier.Use;
        this.symbol.associated = [];
        this.references = [];
    }

    push(transformer: NodeTransformer) {
        if (transformer.tokenType === TokenType.Function) {
            this.symbol.kind = SymbolKind.Function;
        } else if (transformer.tokenType === TokenType.Const) {
            this.symbol.kind = SymbolKind.Constant;
        } else if (transformer.phraseType === PhraseType.NamespaceName) {
            const text = (<NamespaceNameTransformer>transformer).text;
            const ref = (<NamespaceNameTransformer>transformer).reference;
            ref.kind = this.symbol.kind;
            this.symbol.name = PhpSymbol.notFqn(text);
            this.symbol.associated.push(ref);
            this.references.push(ref);
        } else if (transformer.phraseType === PhraseType.NamespaceAliasingClause) {
            this.symbol.name = (<NamespaceAliasingClauseTransformer>transformer).text;
            const ref = (<NamespaceAliasingClauseTransformer>transformer).reference;
            if(!ref) {
                return;
            }
            
            if(this.references[0]) {
                ref.name = this.references[0].name;    
            }
            this.references.push(ref);
        }
    }

}

class NamespaceAliasingClauseTransformer implements TextTransformer, ReferenceTransformer {

    phraseType = PhraseType.NamespaceAliasingClause;
    text = '';
    reference: Reference;

    constructor(public node: Phrase|Token) { }

    push(transform: NodeTransformer) {
        if (transform.tokenType === TokenType.Name) {
            this.text = (<TokenTransform>transform).text;
            this.reference = (<ReferencePhrase>this.node).reference = Reference.create(
                SymbolKind.Class,
                this.text,
                (<TokenTransform>transform).location.range
            );
            this.reference.unresolvedName = this.text;
        }
    }

}

