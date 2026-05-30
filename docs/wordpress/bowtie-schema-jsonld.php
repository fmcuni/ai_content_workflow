<?php
/**
 * Plugin Name: Bowtie Schema JSON-LD
 * Description: Emits the AI Content Tool's structured-data graph in the page
 *              <head> via the Yoast / RankMath schema filters, reading it from
 *              the `_bowtie_schema_jsonld` post meta. Keeps the post body free
 *              of raw <script type="application/ld+json"> markup.
 * Version:     1.0.0
 * Author:      Bowtie
 *
 * INSTALL (one-time, per WordPress environment):
 *   Drop this file into wp-content/mu-plugins/ (must-use plugins auto-activate;
 *   create the folder if it does not exist). No activation step required.
 *
 * CONTRACT WITH THE PUBLISHER:
 *   The AI Content Tool's publish step writes the post meta key
 *   `_bowtie_schema_jsonld` (see SCHEMA_JSONLD_META_KEY in
 *   content_tool/wordpress/client.py) with a JSON-encoded *array* of schema.org
 *   graph pieces, e.g.
 *     [
 *       {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[...]},
 *       {"@context":"https://schema.org","@type":"DefinedTermSet","hasDefinedTerm":[...]}
 *     ]
 *   No PII is ever placed here — public editorial schema only.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const BOWTIE_SCHEMA_META_KEY = '_bowtie_schema_jsonld';

/**
 * Register the meta key so the WordPress REST API will accept it on
 * create/update and so it is readable back. Writes require edit_posts.
 */
add_action(
	'init',
	static function (): void {
		register_post_meta(
			'post',
			BOWTIE_SCHEMA_META_KEY,
			array(
				'type'              => 'string',
				'single'            => true,
				'show_in_rest'      => true,
				'sanitize_callback' => static function ( $value ) {
					// Store verbatim only if it is valid JSON; otherwise drop it
					// so a malformed payload can never reach the page head.
					if ( ! is_string( $value ) || '' === $value ) {
						return '';
					}
					json_decode( $value );
					return ( JSON_ERROR_NONE === json_last_error() ) ? $value : '';
				},
				'auth_callback'     => static function (): bool {
					return current_user_can( 'edit_posts' );
				},
			)
		);
	}
);

/**
 * Decode the stored graph for a given post into a list of associative arrays.
 *
 * @return array<int, array<string, mixed>>
 */
function bowtie_schema_pieces( int $post_id ): array {
	$raw = get_post_meta( $post_id, BOWTIE_SCHEMA_META_KEY, true );
	if ( ! is_string( $raw ) || '' === $raw ) {
		return array();
	}
	$decoded = json_decode( $raw, true );
	if ( ! is_array( $decoded ) ) {
		return array();
	}
	// Accept either a single piece object or a list of pieces.
	$pieces = isset( $decoded['@type'] ) ? array( $decoded ) : $decoded;

	$out = array();
	foreach ( $pieces as $piece ) {
		if ( is_array( $piece ) && isset( $piece['@type'] ) ) {
			$out[] = $piece;
		}
	}
	return $out;
}

/**
 * Yoast SEO: merge our pieces into the schema @graph.
 * Filter docs: https://developer.yoast.com/customization/yoast-seo/adding-schema-graph-pieces/
 */
add_filter(
	'wpseo_schema_graph',
	static function ( $graph, $context ) {
		if ( ! is_array( $graph ) || ! is_singular() ) {
			return $graph;
		}
		$post_id = get_the_ID() ?: 0;
		if ( ! $post_id ) {
			return $graph;
		}
		foreach ( bowtie_schema_pieces( (int) $post_id ) as $piece ) {
			// Yoast graph pieces should not repeat @context (the graph root holds it).
			unset( $piece['@context'] );
			$graph[] = $piece;
		}
		return $graph;
	},
	10,
	2
);

/**
 * RankMath: merge our pieces into the JSON-LD data array.
 * Filter docs: https://rankmath.com/kb/filters-hooks-api-developer/#change-json-ld-data
 */
add_filter(
	'rank_math/json_ld',
	static function ( $data, $jsonld ) {
		if ( ! is_array( $data ) || ! is_singular() ) {
			return $data;
		}
		$post_id = get_the_ID() ?: 0;
		if ( ! $post_id ) {
			return $data;
		}
		$i = 0;
		foreach ( bowtie_schema_pieces( (int) $post_id ) as $piece ) {
			$data[ 'bowtie_' . ( $i++ ) ] = $piece;
		}
		return $data;
	},
	99,
	2
);

/**
 * Fallback for installs running NEITHER Yoast NOR RankMath: emit the graph
 * directly in wp_head. Guarded so we never double-print when a supported SEO
 * plugin is active (those paths above already handle it).
 */
add_action(
	'wp_head',
	static function (): void {
		if ( defined( 'WPSEO_VERSION' ) || class_exists( 'RankMath' ) ) {
			return;
		}
		if ( ! is_singular() ) {
			return;
		}
		$post_id = get_the_ID() ?: 0;
		$pieces  = $post_id ? bowtie_schema_pieces( (int) $post_id ) : array();
		if ( empty( $pieces ) ) {
			return;
		}
		$graph = array(
			'@context' => 'https://schema.org',
			'@graph'   => array_map(
				static function ( $piece ) {
					unset( $piece['@context'] );
					return $piece;
				},
				$pieces
			),
		);
		echo "\n<script type=\"application/ld+json\">" .
			wp_json_encode( $graph, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) .
			"</script>\n";
	},
	20
);
