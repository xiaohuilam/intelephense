import { SymbolStore, NameResolver, PhpSymbol, SymbolKind, ExpressionTypeResolver, VariableTable, TypeString } from './symbol';
import { TreeTraverser } from './types';
import { ParsedDocument } from './parsedDocument';
import { Position } from 'vscode-languageserver-types';
import { Phrase, Token, NamespaceDefinition, ClassDeclaration, TokenType } from 'php7parser';
export declare class Context {
    symbolStore: SymbolStore;
    document: ParsedDocument;
    position: Position;
    private _parseTreeSpine;
    private _offset;
    private _namespaceDefinition;
    private _scopePhrase;
    private _scopeSymbol;
    private _variableTable;
    private _thisPhrase;
    private _thisSymbol;
    private _thisBaseSymbol;
    private _namespaceName;
    constructor(symbolStore: SymbolStore, document: ParsedDocument, position: Position);
    readonly word: string;
    readonly token: Token;
    readonly offset: number;
    readonly spine: (Token | Phrase)[];
    readonly thisName: string;
    readonly thisBaseName: string;
    readonly namespaceName: string;
    readonly namespacePhrase: NamespaceDefinition;
    readonly thisPhrase: ClassDeclaration;
    readonly thisSymbol: PhpSymbol;
    readonly thisBaseSymbol: PhpSymbol;
    readonly scopePhrase: Phrase;
    readonly scopeSymbol: PhpSymbol;
    readonly variableTable: VariableTable;
    tokenText(t: Token): string;
    nodeText(node: Phrase | Token, ignore?: TokenType[]): string;
    resolveFqn(phrase: Phrase, kind: SymbolKind): string;
    resolveExpressionType(expr: Phrase): TypeString;
    createNameResolver(): NameResolver;
    createTraverser(): TreeTraverser<Token | Phrase>;
    createExpressionTypeResolver(): ExpressionTypeResolver;
    private _isScopePhrase(p);
    private _isScopeBody(p);
    private _importFilter(s);
    private _isNamespaceDefinition(node);
    private _isClassDeclaration(node);
}
