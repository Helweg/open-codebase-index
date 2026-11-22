# open-codebase-index

open-codebase-index indexes repositories so developers and agents can find code and understand how it fits together.

## Language

**Branch catalog**:
The set of indexed chunks and symbols that belong to a particular branch. The same chunk or symbol can belong to more than one branch catalog.

**Branch call graph**:
The indexed call relationships for a particular branch. Identical caller source on two branches can resolve to different targets.

**Resolved call**:
A call site in the branch call graph that is linked to a specific target symbol. An unresolved call records the call site without claiming a target.

**Structural index**:
An index that supports keyword retrieval, definition lookup, and call graph queries without embeddings. A hybrid index also supports retrieval using embeddings.
