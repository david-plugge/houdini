<script lang="ts">
  import { paginatedFragment, graphql } from '$houdini';

  const queryResult = graphql(`
    query UserFragmentOffsetQuery {
      user(id: "1", snapshot: "pagination-fragment-offset") {
        ...OffsetFragment
      }
    }
  `);

  const fragmentResult = paginatedFragment(
    $queryResult.data?.user ?? null,
    graphql(`
      fragment OffsetFragment on User {
        friendsList(limit: 2) @paginate {
          name
        }
      }
    `)
  );
</script>

<div id="result">
  {$fragmentResult?.data?.friendsList.map((node) => node?.name).join(', ')}
</div>

<button id="next" on:click={() => fragmentResult?.loadNextPage()}>next</button>
