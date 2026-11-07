<?php
/**
 * Netivo Plugin Repository Client for WordPress
 *
 * Provides update checking and metadata discovery against the Netivo Cloudflare
 * plugin repository (https://updates.netivo.pl).
 *
 * @package Netivo\PluginRepository\Client
 */

declare(strict_types=1);

namespace Netivo\PluginRepository\Client;

use WP_Error;

/**
 * Class RepoClient
 */
class RepoClient {

	public const DEFAULT_REPO_URL = 'https://updates.netivo.dev';
	public const DEFAULT_TIMEOUT_SECONDS = 4;
	public const DEFAULT_CACHE_TTL_SECONDS = 3600; // 1 hour

	/**
	 * Constructor.
	 *
	 * @param string $slug            Plugin slug identifier (e.g. 'netivo-action-logger-mu').
	 * @param string $repoUrl         Base repository URL.
	 * @param int    $cacheTtlSeconds Transient cache duration in seconds (0 to disable).
	 */
	public function __construct(
		private readonly string $slug,
		private readonly string $repoUrl = self::DEFAULT_REPO_URL,
		private readonly int $cacheTtlSeconds = self::DEFAULT_CACHE_TTL_SECONDS
	) {
	}

	/**
	 * Fetches metadata for the latest release.
	 *
	 * @param bool $forceRefresh If true, bypasses transient cache.
	 * @return array{
	 *     version: string,
	 *     tag: string,
	 *     zip_url: string,
	 *     sha256: string|null,
	 *     checksum_url: string|null,
	 *     requires_php: string,
	 *     requires_wp: string,
	 *     tested_wp: string,
	 *     changelog: string
	 * }|null Returns null if release metadata cannot be retrieved.
	 */
	public function latest_release( bool $forceRefresh = false ): ?array {
		$manifest = $this->fetch_manifest( $forceRefresh );
		if ( null === $manifest || ! isset( $manifest['latest'], $manifest['versions'] ) ) {
			return null;
		}

		$latestVersion = (string) $manifest['latest'];
		$versionData   = $manifest['versions'][ $latestVersion ] ?? null;

		if ( ! is_array( $versionData ) || ! isset( $versionData['download_url'] ) ) {
			return null;
		}

		return [
			'version'      => $latestVersion,
			'tag'          => (string) ( $versionData['tag'] ?? 'v' . $latestVersion ),
			'zip_url'      => (string) $versionData['download_url'],
			'sha256'       => is_string( $versionData['checksum']['value'] ?? null ) ? strtolower( trim( $versionData['checksum']['value'] ) ) : null,
			'checksum_url' => is_string( $versionData['checksum']['url'] ?? null ) ? (string) $versionData['checksum']['url'] : null,
			'requires_php' => (string) ( $versionData['requires_php'] ?? '8.2' ),
			'requires_wp'  => (string) ( $versionData['requires_wp'] ?? '6.3' ),
			'tested_wp'    => (string) ( $versionData['tested_wp'] ?? '6.7' ),
			'changelog'    => (string) ( $versionData['changelog'] ?? '' ),
		];
	}

	/**
	 * Retrieves the entire version history for rollbacks, auditing, or changelog inspection.
	 *
	 * @param bool $forceRefresh If true, bypasses transient cache.
	 * @return array<string, array<string, mixed>>|null
	 */
	public function full_history( bool $forceRefresh = false ): ?array {
		$manifest = $this->fetch_manifest( $forceRefresh );
		return is_array( $manifest['versions'] ?? null ) ? $manifest['versions'] : null;
	}

	/**
	 * Fetches the global repository catalog (/index.json).
	 *
	 * @param string $repoUrl Optional override repository base URL.
	 * @return array<string, mixed>|null
	 */
	public static function fetch_catalog( string $repoUrl = self::DEFAULT_REPO_URL ): ?array {
		$url = sprintf( '%s/index.json', rtrim( $repoUrl, '/' ) );

		$response = wp_remote_get(
			$url,
			[
				'headers' => [
					'Accept'     => 'application/json',
					'User-Agent' => 'Netivo-Plugin-Repo-Client/1.0; ' . home_url(),
				],
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
			]
		);

		if ( $response instanceof WP_Error || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return null;
		}

		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		return is_array( $decoded ) ? $decoded : null;
	}

	/**
	 * Verifies the SHA-256 integrity of a downloaded file against expected hash.
	 *
	 * @param string      $filePath Local file path.
	 * @param string|null $expectedSha256 Expected 64-character hex hash.
	 * @return bool True if valid or if expected hash is null (unverified); false if mismatch.
	 */
	public static function verify_checksum( string $filePath, ?string $expectedSha256 ): bool {
		if ( null === $expectedSha256 || '' === trim( $expectedSha256 ) ) {
			return true;
		}

		if ( ! file_exists( $filePath ) || ! is_readable( $filePath ) ) {
			return false;
		}

		$actualHash = hash_file( 'sha256', $filePath );
		if ( false === $actualHash ) {
			return false;
		}

		return hash_equals( strtolower( trim( $expectedSha256 ) ), strtolower( $actualHash ) );
	}

	/**
	 * Fetches the decoded manifest for this client's slug, leveraging transient caching.
	 *
	 * @param bool $forceRefresh If true, bypasses transient cache.
	 * @return array<string, mixed>|null
	 */
	public function fetch_manifest( bool $forceRefresh = false ): ?array {
		$cacheKey = 'netivo_manifest_' . md5( $this->slug . '_' . $this->repoUrl );

		if ( ! $forceRefresh && $this->cacheTtlSeconds > 0 && function_exists( 'get_site_transient' ) ) {
			$cached = get_site_transient( $cacheKey );
			if ( is_array( $cached ) ) {
				return $cached;
			}
		}

		$url = sprintf( '%s/%s/info.json', rtrim( $this->repoUrl, '/' ), $this->slug );

		$response = wp_remote_get(
			$url,
			[
				'headers' => [
					'Accept'     => 'application/json',
					'User-Agent' => 'Netivo-Plugin-Repo-Client/1.0; ' . ( function_exists( 'home_url' ) ? home_url() : '' ),
				],
				'timeout' => self::DEFAULT_TIMEOUT_SECONDS,
			]
		);

		if ( $response instanceof WP_Error || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return null;
		}

		$decoded = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $decoded ) ) {
			return null;
		}

		if ( $this->cacheTtlSeconds > 0 && function_exists( 'set_site_transient' ) ) {
			set_site_transient( $cacheKey, $decoded, $this->cacheTtlSeconds );
		}

		return $decoded;
	}
}
